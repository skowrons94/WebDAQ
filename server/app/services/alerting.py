"""
AlertManager — what WebDAQ watches, and where it says so.

Board failures used to be the only alert, hard-wired to Telegram. A shift wants
more than that: a board that stops producing data without raising the FAIL flag,
a beam current that drops, an accelerator value leaving its range — and it wants
to choose whether that lands in Telegram or Zulip.

So an alert is a *rule*: what to watch, the threshold, how long the condition has
to hold, and which transports carry it. Rules live in conf/alerts.json and are
edited from Settings -> Notifications.

Two things keep alerts trustworthy rather than noisy:

* **One message per episode.** A rule fires when its condition becomes true and
  stays quiet until it clears again (and then says it cleared, if asked to). A
  beam current sitting just below its threshold is one message, not one a tick.
* **Unknown is not false.** A Graphite server that cannot be reached, or a
  current monitor that is not connected, leaves a rule exactly as it was. An
  outage in the monitoring path must not invent an alert, nor clear a real one.

The watching itself is deliberately dull: one thread, one pass per tick, every
measurement taken through a small set of callables (`AlertSources`) so the whole
engine can be tested without hardware, without Graphite and without a run.
"""

import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

_CONFIG_FILE = 'conf/alerts.json'

# How often the watcher looks. A board stall is measured in tens of seconds and a
# beam current changes in seconds, so this is fast enough to matter and slow
# enough to be free. Graphite rules throttle themselves further (poll_seconds).
DEFAULT_TICK_S = 2.0

BOARD_FAILURE = 'board_failure'
STALLED_BUFFERS = 'stalled_buffers'
BEAM_CURRENT = 'beam_current'
GRAPHITE_METRIC = 'graphite_metric'

RULE_TYPES = (BOARD_FAILURE, STALLED_BUFFERS, BEAM_CURRENT, GRAPHITE_METRIC)
TRANSPORTS = ('telegram', 'zulip')
COMPARISONS = ('below', 'above')

# A rule type's defaults, and what the UI needs to render it.
RULE_DEFAULTS: Dict[str, Dict[str, Any]] = {
    BOARD_FAILURE: {
        'name': 'Board failure',
        'description': 'A board sets its FAIL flag during a run.',
        'params': {},
    },
    STALLED_BUFFERS: {
        'name': 'Board stopped producing data',
        'description': 'A board reads no new data blocks during a run, without '
                       'necessarily raising the FAIL flag.',
        'params': {'seconds': 60},
    },
    BEAM_CURRENT: {
        'name': 'Beam current',
        'description': 'The beam current read by the current monitor leaves its range.',
        'params': {'comparison': 'below', 'threshold': 1.0, 'seconds': 60,
                   'during_run_only': True},
    },
    GRAPHITE_METRIC: {
        'name': 'Graphite metric',
        'description': 'A monitored value (terminal voltage, pressure, …) leaves its range.',
        'params': {'metric': '', 'comparison': 'below', 'threshold': 0.0,
                   'seconds': 60, 'poll_seconds': 30, 'during_run_only': False},
    },
}

_MIN_SECONDS = 0
_MIN_POLL_S = 5

# The same subject of the same rule is not announced twice inside this window, so
# a value sitting exactly on its threshold cannot flood the chat or the history.
_MIN_RE_ALERT_S = 60.0

# A current monitor that has produced nothing for this long is treated as unknown
# rather than as reading its last value.
_STALE_AFTER_S = 30.0


class AlertConfigError(ValueError):
    """A rule the operator has to fix. The message is shown verbatim in the UI."""


class AlertSources:
    """Everything the engine measures, as replaceable callables.

    The defaults read the live services; the tests pass their own. Nothing here
    may raise: a source that cannot answer returns None (or an empty mapping),
    which the engine reads as "unknown" and acts on by leaving rules alone.
    """

    def __init__(self,
                 board_diagnostics: Optional[Callable[[], Dict[str, Dict[str, Any]]]] = None,
                 is_running: Optional[Callable[[], bool]] = None,
                 run_number: Optional[Callable[[], Optional[int]]] = None,
                 beam_current: Optional[Callable[[], Optional[float]]] = None,
                 metric_value: Optional[Callable[[str], Optional[float]]] = None):
        self.board_diagnostics = board_diagnostics or _live_board_diagnostics
        self.is_running = is_running or _live_is_running
        self.run_number = run_number or _live_run_number
        self.beam_current = beam_current or _live_beam_current
        self.metric_value = metric_value or _live_metric_value


# --- the live sources, each importing lazily so this module stays importable ---

def _live_board_diagnostics() -> Dict[str, Dict[str, Any]]:
    try:
        from .caen_acquisition import get_caen_acquisition
        return get_caen_acquisition().board_diagnostics()
    except Exception as e:
        logger.debug(f"alerting: no board diagnostics: {e}")
        return {}


def _live_is_running() -> bool:
    try:
        from .daq_manager import get_daq_manager
        return bool(get_daq_manager().is_running())
    except Exception:
        return False


def _live_run_number() -> Optional[int]:
    try:
        from .daq_manager import get_daq_manager
        return get_daq_manager().get_run_number()
    except Exception:
        return None


def max_sample_age(controller: Any) -> float:
    """How old this source's newest sample may be before it stops being news.

    Hardware on the target answers immediately, so _STALE_AFTER_S is right for
    it. A source whose samples come from somewhere else — a metric published on
    its own cadence and served by an archive — knows better, and says so.
    """
    try:
        reported = controller.max_sample_age()
        if reported and reported > 0:
            return float(reported)
    except (AttributeError, TypeError, ValueError):
        pass
    return _STALE_AFTER_S


def _live_beam_current() -> Optional[float]:
    """The latest beam current in µA, or None when there is nothing to read.

    "Nothing to read" covers the case that matters during a campaign: a monitor
    that is still *connected* but has stopped producing samples — a dead reader
    thread, an instrument left in a menu, a Graphite metric that stopped arriving.
    Its last reading would otherwise sit there looking like a measurement, and a
    beam-current rule would happily keep quiet (or stay latched) on a number from
    an hour ago. A timestamped sample is used when the controller offers one, so
    silence reads as unknown rather than as good news.

    The current module can be swapped at runtime, so the controller is looked up
    through the module rather than held.
    """
    try:
        from ..routes import current as current_routes
        controller = current_routes.controller
        if controller is None or not controller.is_connected():
            return None
        value = None
        history = None
        if hasattr(controller, 'get_history'):
            history = controller.get_history(since=time.time() - max_sample_age(controller),
                                             max_points=64)
            if history:
                value = history[-1][1]
        if value is None:
            if history is not None:
                return None          # connected, but nothing recent to report
            data = controller.get_data()
            if isinstance(data, dict):  # multi-channel (TetrAMM): charge channel
                data = data.get(str(controller.get_charge_channel()))
            value = data
        value = float(value)
    except Exception as e:
        logger.debug(f"alerting: no beam current: {e}")
        return None
    if value != value:              # NaN
        return None
    return value


def _live_metric_value(metric: str) -> Optional[float]:
    """The latest value of one Graphite metric, or None if it cannot be read."""
    if not metric:
        return None
    try:
        from . import graphite_reader
        series = graphite_reader.fetch_series(metric, '-5min', 'now')
    except Exception as e:
        logger.debug(f"alerting: metric {metric} failed: {e}")
        return None
    for _, value in reversed(series or []):
        if value is not None:
            return float(value)
    return None


class AlertManager:
    def __init__(self, sources: Optional[AlertSources] = None,
                 transports: Optional[Dict[str, Any]] = None,
                 clock: Callable[[], float] = time.time):
        self.logger = logging.getLogger(__name__ + '.AlertManager')
        self.sources = sources or AlertSources()
        self._transports = transports          # None -> resolved lazily (real ones)
        self.clock = clock
        self.rules: List[Dict[str, Any]] = []
        # Rules the file held but that could not be understood, and why — shown on
        # the settings page instead of disappearing.
        self.rejected_rules: List[Dict[str, Any]] = []
        self.load_error = ''
        self.notify_recovery = True
        # Rule state, keyed by (rule id, subject): subject is a board id for
        # board-scoped rules and '' for the rest.
        self.state: Dict[str, Dict[str, Any]] = {}
        # Reentrant: the rule state is written by the watcher thread and by the
        # board monitor, and read by every settings request. Held only for the
        # dictionary work — never across a network send.
        self._lock = threading.RLock()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._load()

    # ---------------------------------------------------------------- transports
    def transports(self) -> Dict[str, Any]:
        if self._transports is None:
            from .daq_manager import get_daq_manager
            from .zulip_notifier import get_zulip_notifier
            self._transports = {
                'telegram': get_daq_manager().telegram,
                'zulip': get_zulip_notifier(),
            }
        return self._transports

    # ------------------------------------------------------------------- config
    def _load(self) -> None:
        if os.path.exists(_CONFIG_FILE):
            try:
                with open(_CONFIG_FILE, 'r') as f:
                    conf = json.load(f)
                # One unreadable rule must not cost the others: keep every rule
                # that makes sense and report the rest, rather than silently
                # falling back to the defaults and losing a shift's work.
                self.rules, self.rejected_rules = [], []
                for raw in conf.get('rules', []):
                    try:
                        self.rules.append(self._normalise(raw))
                    except AlertConfigError as e:
                        self.rejected_rules.append({'rule': raw, 'reason': str(e)})
                        self.logger.error(f"Ignoring an alert rule: {e}")
                self.notify_recovery = bool(conf.get('notify_recovery', True))
                self.logger.info(f"Loaded {len(self.rules)} alert rule(s)"
                                 + (f", {len(self.rejected_rules)} ignored"
                                    if self.rejected_rules else ""))
                return
            except Exception as e:
                # Do not quietly replace the operator's rules with the defaults:
                # keep the unreadable file so it can be looked at (or fixed).
                self.logger.error(f"Error loading alert rules: {e}")
                stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
                backup = f"{_CONFIG_FILE}.unreadable-{stamp}"
                try:
                    os.replace(_CONFIG_FILE, backup)
                    self.logger.error(f"Kept the unreadable rules as {backup}")
                    self.load_error = (f"The alert rules could not be read and were "
                                       f"replaced by the default rule. The file is kept "
                                       f"as {backup}.")
                except OSError as move_error:
                    self.logger.error(f"Could not keep the unreadable rules: {move_error}")
        # First start: keep doing what WebDAQ did before rules existed — tell
        # Telegram about board failures — so an upgrade changes nothing silently.
        self.rules = [self._normalise({
            'type': BOARD_FAILURE, 'enabled': True, 'transports': ['telegram']})]
        self.notify_recovery = True
        self._save()

    def _save(self) -> None:
        try:
            os.makedirs(os.path.dirname(_CONFIG_FILE), exist_ok=True)
            with open(_CONFIG_FILE, 'w') as f:
                json.dump({'notify_recovery': self.notify_recovery,
                           'rules': self.rules}, f, indent=4)
        except Exception as e:
            self.logger.error(f"Error saving alert rules: {e}")

    def _normalise(self, rule: Dict[str, Any]) -> Dict[str, Any]:
        """Validate and complete one rule. Raises AlertConfigError on nonsense."""
        kind = str(rule.get('type', '')).strip()
        if kind not in RULE_TYPES:
            raise AlertConfigError(
                f"Unknown alert type {kind!r}. Known types: {', '.join(RULE_TYPES)}.")
        defaults = RULE_DEFAULTS[kind]

        transports = rule.get('transports')
        if transports is None:
            transports = ['telegram']
        if isinstance(transports, str):
            transports = [transports]
        unknown = [t for t in transports if t not in TRANSPORTS]
        if unknown:
            raise AlertConfigError(
                f"Unknown destination {unknown[0]!r}. Known: {', '.join(TRANSPORTS)}.")

        out: Dict[str, Any] = {
            'id': str(rule.get('id') or uuid.uuid4().hex[:12]),
            'type': kind,
            'name': str(rule.get('name') or defaults['name']).strip(),
            'enabled': bool(rule.get('enabled', True)),
            'transports': list(dict.fromkeys(transports)),   # de-duplicated, ordered
        }

        params = dict(defaults['params'])
        given = rule.get('params') or {}
        unknown_params = [k for k in given if k not in defaults['params']]
        if unknown_params:
            # Silently dropping these let a rule be "saved" with a threshold the
            # operator never chose.
            raise AlertConfigError(
                f"{RULE_DEFAULTS[kind]['name']} has no setting called "
                f"'{unknown_params[0]}'. It takes: "
                f"{', '.join(sorted(defaults['params'])) or 'no settings'}.")
        params.update({k: v for k, v in given.items() if k in defaults['params']})

        if 'comparison' in params:
            if params['comparison'] not in COMPARISONS:
                raise AlertConfigError(
                    f"Comparison must be one of {', '.join(COMPARISONS)}.")
        if 'threshold' in params:
            try:
                params['threshold'] = float(params['threshold'])
            except (TypeError, ValueError):
                raise AlertConfigError("The threshold has to be a number.")
        for key, minimum in (('seconds', _MIN_SECONDS), ('poll_seconds', _MIN_POLL_S)):
            if key in params:
                try:
                    params[key] = max(minimum, int(params[key]))
                except (TypeError, ValueError):
                    raise AlertConfigError(f"'{key}' has to be a whole number of seconds.")
        if 'during_run_only' in params:
            params['during_run_only'] = bool(params['during_run_only'])
        if kind == GRAPHITE_METRIC:
            params['metric'] = str(params.get('metric') or '').strip()
            if not params['metric']:
                raise AlertConfigError("A Graphite rule needs a metric path.")

        out['params'] = params
        return out

    # -------------------------------------------------------------- rules (CRUD)
    def get_rules(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(r, params=dict(r['params'])) for r in self.rules]

    def get_rule_types(self) -> List[Dict[str, Any]]:
        """What the settings page needs to offer the rule types."""
        return [{'type': kind, 'name': d['name'], 'description': d['description'],
                 'params': dict(d['params'])} for kind, d in RULE_DEFAULTS.items()]

    def add_rule(self, rule: Dict[str, Any]) -> Dict[str, Any]:
        prepared = self._normalise(dict(rule, id=None))
        with self._lock:
            self.rules.append(prepared)
            self._save()
        return dict(prepared)

    def update_rule(self, rule_id: str, changes: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            for index, existing in enumerate(self.rules):
                if existing['id'] != rule_id:
                    continue
                merged = dict(existing)
                merged.update({k: v for k, v in changes.items() if k != 'id'})
                if 'params' in changes:
                    merged['params'] = dict(existing['params'],
                                            **(changes.get('params') or {}))
                prepared = self._normalise(dict(merged, id=rule_id))
                self.rules[index] = prepared
                # The rule now watches something else; its old verdict does not apply.
                self._forget(rule_id)
                self._save()
                return dict(prepared)
        raise AlertConfigError(f"No alert rule with id {rule_id!r}.")

    def delete_rule(self, rule_id: str) -> None:
        with self._lock:
            before = len(self.rules)
            self.rules = [r for r in self.rules if r['id'] != rule_id]
            if len(self.rules) == before:
                raise AlertConfigError(f"No alert rule with id {rule_id!r}.")
            self._forget(rule_id)
            self._save()

    def set_notify_recovery(self, enabled: bool) -> None:
        with self._lock:
            self.notify_recovery = bool(enabled)
            self._save()

    def _forget(self, rule_id: str) -> None:
        with self._lock:
            for key in [k for k in self.state if k.startswith(f"{rule_id}:")]:
                del self.state[key]

    # -------------------------------------------------------------------- status
    def ready_transports(self) -> Dict[str, bool]:
        """Which transports could actually deliver right now (on and configured)."""
        ready = {}
        for name, transport in self.transports().items():
            try:
                ready[name] = bool(getattr(transport, 'enabled', False)) and \
                    bool(transport.is_configured())
            except Exception:
                ready[name] = False
        return ready

    def get_status(self) -> Dict[str, Any]:
        """What each rule currently thinks, for the settings page."""
        ready = self.ready_transports()
        with self._lock:
            rules = []
            for rule in self.rules:
                subjects = {k.split(':', 1)[1]: dict(v) for k, v in self.state.items()
                            if k.startswith(f"{rule['id']}:")}
                unmeasured = [s.get('unmeasured_since') for s in subjects.values()
                              if s.get('unmeasured_since')]
                rules.append({
                    'id': rule['id'],
                    'alerting': any(s.get('latched') for s in subjects.values()),
                    # True when every subject of this rule has had nothing to
                    # measure: an unreachable Graphite, a monitor that stopped, a
                    # counter this caendaq build does not report.
                    'unmeasured': bool(unmeasured) and len(unmeasured) == len(subjects),
                    'unmeasured_for': (int(self.clock() - min(unmeasured))
                                       if unmeasured else None),
                    # An enabled rule whose destinations are all off or
                    # unconfigured watches faithfully and tells nobody.
                    'deliverable': any(ready.get(t) for t in rule['transports']),
                    'transports_not_ready': [t for t in rule['transports']
                                             if not ready.get(t)],
                    'subjects': {name: {'latched': bool(s.get('latched')),
                                        'value': s.get('value'),
                                        'last_fired': s.get('last_fired')}
                                 for name, s in subjects.items()},
                })
            return {'rules': rules, 'notify_recovery': self.notify_recovery,
                    'watching': self.is_watching(),
                    'transports_ready': ready,
                    # Rules the file held that could not be understood, so they do
                    # not simply vanish from the page.
                    'rejected_rules': list(self.rejected_rules),
                    'load_error': self.load_error}

    # What a new run invalidates: these watch counters that restart with the run.
    RUN_SCOPED_TYPES = (BOARD_FAILURE, STALLED_BUFFERS)

    def reset_run_state(self) -> None:
        """Forget the verdicts that belong to the previous run.

        Board counters restart with the run, so a failure or a stall from the last
        run must not keep the next one's alert suppressed. A beam current or a
        Graphite value knows nothing about runs: clearing those as well sent one
        duplicate message per run all night, which is how a channel gets ignored.
        """
        with self._lock:
            run_scoped = {rule['id'] for rule in self.rules
                          if rule['type'] in self.RUN_SCOPED_TYPES}
            for key in [k for k in self.state if k.split(':', 1)[0] in run_scoped]:
                del self.state[key]

    # ------------------------------------------------------------------ delivery
    def _send(self, rule: Dict[str, Any], title: str, lines: List[str]) -> Dict[str, bool]:
        results: Dict[str, bool] = {}
        transports = self.transports()
        for name in rule['transports']:
            transport = transports.get(name)
            if transport is None:
                continue
            try:
                if hasattr(transport, 'format'):
                    message = transport.format(title, lines)
                else:
                    message = title + '\n\n' + '\n'.join(lines)
                results[name] = bool(transport.send_message(message))
            except Exception as e:
                self.logger.error(f"Alert via {name} failed: {e}")
                results[name] = False
        if not any(results.values()):
            self.logger.warning(f"Alert '{title}' reached nobody (destinations: "
                                f"{', '.join(rule['transports']) or 'none'})")
        return results

    def _record(self, kind: str, rule: Dict[str, Any], subject: str, title: str,
                lines: List[str], results: Dict[str, bool]) -> None:
        """Keep the event, so a shift arriving later can read what happened."""
        self._record_event(kind, title, lines, rule_id=rule['id'],
                           rule_type=rule['type'], subject=subject, results=results)

    def _record_event(self, kind: str, title: str, lines: List[str], rule_id: str,
                      rule_type: str, subject: str, results: Dict[str, bool]) -> None:
        try:
            from .alert_log import get_alert_log
            run = None
            try:
                run = self.sources.run_number() if self.sources.is_running() else None
            except Exception:
                run = None
            get_alert_log().record(kind, title, lines, rule_id=rule_id,
                                   rule_type=rule_type, subject=subject,
                                   run_number=run, deliveries=results,
                                   at=self.clock())
        except Exception as e:
            # Recording must never cost an alert.
            self.logger.error(f"Could not log the alert '{title}': {e}")

    # ---------------------------------------------------------------- evaluation
    def evaluate(self) -> List[Dict[str, Any]]:
        """One pass over every enabled rule. Returns the alerts sent, for tests."""
        now = self.clock()
        running = bool(self.sources.is_running())
        sent: List[Dict[str, Any]] = []
        with self._lock:
            rules = list(self.rules)
        # Local measurements first. A Graphite query can take its whole 10 s
        # deadline, and the pass is one thread: putting the remote rules last
        # keeps a sick Graphite from delaying a board-stall alert by that much.
        rules.sort(key=lambda r: r['type'] == GRAPHITE_METRIC)
        for rule in rules:
            if not rule.get('enabled'):
                continue
            try:
                sent.extend(self._evaluate_rule(rule, now, running))
            except Exception as e:
                self.logger.error(f"Alert rule {rule.get('id')} failed: {e}")
        return sent

    def _evaluate_rule(self, rule: Dict[str, Any], now: float,
                       running: bool) -> List[Dict[str, Any]]:
        kind = rule['type']
        if kind == BOARD_FAILURE:
            # Pushed in by the board monitor (see board_failure()), which owns the
            # OK -> failed edge because it also drives the auto-restart. Polling for
            # it here as well would alert twice for one failure.
            return []
        if kind == STALLED_BUFFERS:
            return self._evaluate_stall(rule, now, running)
        if kind == BEAM_CURRENT:
            return self._evaluate_threshold(
                rule, now, running, self.sources.beam_current(), 'Beam current', 'µA')
        if kind == GRAPHITE_METRIC:
            metric = rule['params']['metric']
            if not self._due(rule, now):
                return []
            return self._evaluate_threshold(
                rule, now, running, self.sources.metric_value(metric), metric, '')
        return []

    def _due(self, rule: Dict[str, Any], now: float) -> bool:
        """Throttle a rule that costs a network round trip to read."""
        every = rule['params'].get('poll_seconds') or _MIN_POLL_S
        state = self._state_for(rule, '')
        if now - float(state.get('polled_at') or 0.0) < every:
            return False
        state['polled_at'] = now
        return True

    def _state_for(self, rule: Dict[str, Any], subject: str) -> Dict[str, Any]:
        with self._lock:
            return self.state.setdefault(f"{rule['id']}:{subject}",
                                         {'latched': False, 'since': None, 'value': None,
                                          'last_fired': None})

    def _subject_states(self, rule_id: str) -> List[Dict[str, Any]]:
        """The state entries of one rule, as a snapshot safe to walk."""
        with self._lock:
            return [v for k, v in self.state.items() if k.startswith(f"{rule_id}:")]

    def _run_line(self, running: bool) -> str:
        run = self.sources.run_number()
        if running and run is not None:
            return f"Run: {run} (running)"
        return 'No run is active'

    def _fire(self, rule: Dict[str, Any], subject: str, title: str,
              lines: List[str], now: float, value: Any = None) -> Optional[Dict[str, Any]]:
        state = self._state_for(rule, subject)
        last = state.get('last_fired')
        if last is not None and (now - float(last)) < _MIN_RE_ALERT_S:
            # A condition flapping around its threshold would otherwise send a
            # message every tick and roll the night's history out of the log.
            state.update({'latched': True, 'value': value})
            self.logger.info(f"Alert '{title}' held back: the same subject alerted "
                             f"{int(now - float(last))} s ago")
            return None
        state.update({'latched': True, 'last_fired': now, 'value': value})
        results = self._send(rule, title, lines)
        self._record('alert', rule, subject, title, lines, results)
        return {'rule': rule['id'], 'type': rule['type'], 'subject': subject,
                'title': title, 'lines': lines, 'recovery': False, 'results': results}

    def _clear(self, rule: Dict[str, Any], subject: str, title: str,
               lines: List[str], now: float, value: Any = None) -> List[Dict[str, Any]]:
        state = self._state_for(rule, subject)
        was_latched = bool(state.get('latched'))
        state.update({'latched': False, 'since': None, 'value': value})
        if not (was_latched and self.notify_recovery):
            return []
        results = self._send(rule, title, lines)
        self._record('recovery', rule, subject, title, lines, results)
        return [{'rule': rule['id'], 'type': rule['type'], 'subject': subject,
                 'title': title, 'lines': lines, 'recovery': True, 'results': results}]

    # --- board failure (pushed in by the board monitor) -----------------------
    def board_failure(self, board_id: str, failure_type: str,
                      run_number: Optional[int] = None,
                      extra_lines: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        """A board raised its FAIL flag: tell whoever asked to hear about it.

        Called by the board monitor on the OK -> failed edge. Each rule fires once
        per board per run (the latch is cleared by reset_run_state at run start).
        """
        now = self.clock()
        with self._lock:
            rules = [r for r in self.rules
                     if r['enabled'] and r['type'] == BOARD_FAILURE]
        lines = [f"Board {board_id}: {failure_type}",
                 f"Run: {run_number}" if run_number is not None
                 else self._run_line(bool(self.sources.is_running())),
                 'The data from that point may be incomplete.']
        lines.extend(extra_lines or [])

        sent, considered = [], False
        for rule in rules:
            state = self._state_for(rule, str(board_id))
            if state['latched']:
                considered = True
                continue
            considered = True
            alert = self._fire(rule, str(board_id), rule['name'], lines,
                               now, failure_type)
            if alert:
                sent.append(alert)
        if not considered:
            # Nobody asked to be told — but a board raising its FAIL flag is the
            # event this whole system exists for, and a shift reading the history
            # in the morning must find it there.
            self._record_event('alert', 'Board failure (no alert configured)', lines,
                               rule_id='', rule_type=BOARD_FAILURE,
                               subject=str(board_id), results={})
        return sent

    def has_enabled_rule(self, kind: str) -> bool:
        with self._lock:
            return any(r['enabled'] and r['type'] == kind for r in self.rules)

    # --- a board that stops producing data ------------------------------------
    def _evaluate_stall(self, rule, now, running) -> List[Dict[str, Any]]:
        seconds = rule['params']['seconds']
        if not running:
            # Between runs there is nothing to produce: forget the watch, quietly.
            for state in self._subject_states(rule['id']):
                state.update({'latched': False, 'since': None, 'seen': None})
            return []
        diagnostics = self.sources.board_diagnostics() or {}
        sent = []
        if not diagnostics:
            # The run is active and the acquisition reports no board at all: the
            # whole readout has gone, not one board.
            state = self._state_for(rule, '')
            state['since'] = state.get('since') or now
            missing_for = now - float(state['since'])
            if missing_for >= seconds and not state['latched']:
                alert = self._fire(
                    rule, '', 'No board is producing data',
                    [f"A run is active but no board has reported a counter for "
                     f"{int(missing_for)} s",
                     self._run_line(running),
                     'The acquisition may have stopped without stopping the run — '
                     'check the DAQ and server.log.'],
                    now, None)
                if alert:
                    sent.append(alert)
            return sent
        # The readout is back: clear the "no board at all" verdict.
        whole = self._state_for(rule, '')
        if whole.get('latched'):
            sent.extend(self._clear(
                rule, '', 'Boards are reporting again',
                ['The acquisition is reporting board counters again',
                 self._run_line(running)], now, None))
        else:
            whole['since'] = None
        for board_id, diag in diagnostics.items():
            buffers = diag.get('buffers_read')
            if buffers is None:
                # This caendaq build does not report the counter: say so rather
                # than leaving the board looking watched.
                state = self._state_for(rule, board_id)
                state['unmeasured_since'] = state.get('unmeasured_since') or now
                continue
            state = self._state_for(rule, board_id)
            state['value'] = buffers
            state['measured_at'] = now
            state['unmeasured_since'] = None
            if state.get('seen') != buffers:
                # Progress: note the new count and the moment we saw it move.
                previous = state.get('seen')
                state.update({'seen': buffers, 'since': now})
                if previous is not None and state['latched']:
                    sent.extend(self._clear(
                        rule, board_id, 'Board is producing data again',
                        [f"Board {board_id} is reading data blocks again "
                         f"({buffers} this run)", self._run_line(running)],
                        now, buffers))
                continue
            stalled_for = now - float(state.get('since') or now)
            if stalled_for >= seconds and not state['latched']:
                alert = self._fire(
                    rule, board_id, 'Board stopped producing data',
                    [f"Board {board_id} has read no new data block for "
                     f"{int(stalled_for)} s",
                     f"Data blocks this run: {buffers}",
                     self._run_line(running),
                     'The FAIL flag was not raised — check the board, the link '
                     'and the trigger.'],
                    now, buffers)
                if alert:
                    sent.append(alert)
        return sent

    # --- a value against a threshold ------------------------------------------
    def _evaluate_threshold(self, rule, now, running, value, label,
                            unit) -> List[Dict[str, Any]]:
        params = rule['params']
        if params.get('during_run_only') and not running:
            state = self._state_for(rule, '')
            state.update({'latched': False, 'since': None})
            return []
        if value is None:
            # Unknown: leave the verdict alone, but remember that we could not
            # measure, so the settings page can say "nothing to measure" instead
            # of showing this rule as healthy.
            state = self._state_for(rule, '')
            state['unmeasured_since'] = state.get('unmeasured_since') or now
            return []
        state = self._state_for(rule, '')
        state['value'] = value
        state['measured_at'] = now
        state['unmeasured_since'] = None
        threshold, comparison = params['threshold'], params['comparison']
        breached = value < threshold if comparison == 'below' else value > threshold
        shown = f"{value:g}{(' ' + unit) if unit else ''}"
        limit = f"{threshold:g}{(' ' + unit) if unit else ''}"

        if not breached:
            return self._clear(
                rule, '', f"{rule['name']} is back in range",
                [f"{label} is {shown} ({'above' if comparison == 'below' else 'below'} "
                 f"{limit} again)", self._run_line(running)], now, value)
        if state['since'] is None:
            state['since'] = now
        held_for = now - float(state['since'])
        if held_for < params['seconds'] or state['latched']:
            return []
        lines = [f"{label} is {shown}, {comparison} {limit}"]
        if params['seconds']:
            lines.append(f"It has been {comparison} the limit for {int(held_for)} s")
        lines.append(self._run_line(running))
        alert = self._fire(rule, '', rule['name'], lines, now, value)
        return [alert] if alert else []

    # ------------------------------------------------------------------- watcher
    def is_watching(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self, interval: float = DEFAULT_TICK_S) -> None:
        # A thread that is still alive but told to stop is not watching: starting
        # used to no-op here and report success, leaving nothing evaluating rules.
        if self.is_watching() and not self._stop.is_set():
            return
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
            if self._thread.is_alive():
                self.logger.warning("The previous alert watcher is still finishing a "
                                    "pass; starting a new one alongside it")
        self._stop.clear()
        self._thread = threading.Thread(target=self._watch, args=(interval,),
                                       name='alert-watcher', daemon=True)
        self._thread.start()
        self.logger.info(f"Alert watcher started ({len(self.rules)} rule(s))")

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)
            if self._thread.is_alive():
                # Say so: a pass stuck in a 10 s send is not "stopped".
                self.logger.warning("The alert watcher is still finishing a pass; it "
                                    "will stop when that returns")
                return
        self.logger.info("Alert watcher stopped")

    def _watch(self, interval: float) -> None:
        while not self._stop.is_set():
            try:
                self.evaluate()
            except Exception as e:
                self.logger.error(f"Alert watcher pass failed: {e}")
            if self._stop.wait(interval):
                break


_manager: Optional[AlertManager] = None


def get_alert_manager() -> AlertManager:
    """Get or create the process-wide alert manager."""
    global _manager
    if _manager is None:
        _manager = AlertManager()
    return _manager
