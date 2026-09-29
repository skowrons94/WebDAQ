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


def _live_beam_current() -> Optional[float]:
    """The latest beam current in µA, or None when there is nothing to read.

    The current module can be swapped at runtime, so the controller is looked up
    through the module rather than held.
    """
    try:
        from ..routes import current as current_routes
        controller = current_routes.controller
        if controller is None or not controller.is_connected():
            return None
        data = controller.get_data()
        if isinstance(data, dict):   # multi-channel (TetrAMM): the charge channel
            data = data.get(str(controller.get_charge_channel()))
        value = float(data)
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
        self.notify_recovery = True
        # Rule state, keyed by (rule id, subject): subject is a board id for
        # board-scoped rules and '' for the rest.
        self.state: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
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
                self.rules = [self._normalise(r) for r in conf.get('rules', [])]
                self.notify_recovery = bool(conf.get('notify_recovery', True))
                self.logger.info(f"Loaded {len(self.rules)} alert rule(s)")
                return
            except Exception as e:
                self.logger.error(f"Error loading alert rules: {e}")
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
        params.update({k: v for k, v in (rule.get('params') or {}).items()
                       if k in defaults['params']})

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
        for key in [k for k in self.state if k.startswith(f"{rule_id}:")]:
            del self.state[key]

    # -------------------------------------------------------------------- status
    def get_status(self) -> Dict[str, Any]:
        """What each rule currently thinks, for the settings page."""
        with self._lock:
            rules = []
            for rule in self.rules:
                subjects = {k.split(':', 1)[1]: v for k, v in self.state.items()
                            if k.startswith(f"{rule['id']}:")}
                rules.append({
                    'id': rule['id'],
                    'alerting': any(s.get('latched') for s in subjects.values()),
                    'subjects': {name: {'latched': bool(s.get('latched')),
                                        'value': s.get('value'),
                                        'last_fired': s.get('last_fired')}
                                 for name, s in subjects.items()},
                })
            return {'rules': rules, 'notify_recovery': self.notify_recovery,
                    'watching': self.is_watching()}

    def reset_run_state(self) -> None:
        """Forget every verdict, at the start of a run.

        Board counters restart with the run, so a failure or a stall from the
        previous run must not keep the next one's alert suppressed.
        """
        with self._lock:
            self.state.clear()

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

    # ---------------------------------------------------------------- evaluation
    def evaluate(self) -> List[Dict[str, Any]]:
        """One pass over every enabled rule. Returns the alerts sent, for tests."""
        now = self.clock()
        running = bool(self.sources.is_running())
        sent: List[Dict[str, Any]] = []
        with self._lock:
            rules = list(self.rules)
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
        return self.state.setdefault(f"{rule['id']}:{subject}",
                                     {'latched': False, 'since': None, 'value': None,
                                      'last_fired': None})

    def _run_line(self, running: bool) -> str:
        run = self.sources.run_number()
        if running and run is not None:
            return f"Run: {run} (running)"
        return 'No run is active'

    def _fire(self, rule: Dict[str, Any], subject: str, title: str,
              lines: List[str], now: float, value: Any = None) -> Dict[str, Any]:
        state = self._state_for(rule, subject)
        state.update({'latched': True, 'last_fired': now, 'value': value})
        results = self._send(rule, title, lines)
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
        sent = []
        for rule in rules:
            state = self._state_for(rule, str(board_id))
            if state['latched']:
                continue
            lines = [f"Board {board_id}: {failure_type}",
                     f"Run: {run_number}" if run_number is not None
                     else self._run_line(bool(self.sources.is_running())),
                     'The data from that point may be incomplete.']
            lines.extend(extra_lines or [])
            sent.append(self._fire(rule, str(board_id), rule['name'], lines,
                                   now, failure_type))
        return sent

    def has_enabled_rule(self, kind: str) -> bool:
        with self._lock:
            return any(r['enabled'] and r['type'] == kind for r in self.rules)

    # --- a board that stops producing data ------------------------------------
    def _evaluate_stall(self, rule, now, running) -> List[Dict[str, Any]]:
        seconds = rule['params']['seconds']
        if not running:
            # Between runs there is nothing to produce: forget the watch, quietly.
            for key in [k for k in self.state if k.startswith(f"{rule['id']}:")]:
                self.state[key].update({'latched': False, 'since': None, 'seen': None})
            return []
        sent = []
        for board_id, diag in (self.sources.board_diagnostics() or {}).items():
            buffers = diag.get('buffers_read')
            if buffers is None:
                continue
            state = self._state_for(rule, board_id)
            state['value'] = buffers
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
                sent.append(self._fire(
                    rule, board_id, 'Board stopped producing data',
                    [f"Board {board_id} has read no new data block for "
                     f"{int(stalled_for)} s",
                     f"Data blocks this run: {buffers}",
                     self._run_line(running),
                     'The FAIL flag was not raised — check the board, the link '
                     'and the trigger.'],
                    now, buffers))
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
            return []                      # unknown: leave the verdict alone
        state = self._state_for(rule, '')
        state['value'] = value
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
        return [self._fire(rule, '', rule['name'], lines, now, value)]

    # ------------------------------------------------------------------- watcher
    def is_watching(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self, interval: float = DEFAULT_TICK_S) -> None:
        if self.is_watching():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._watch, args=(interval,),
                                       name='alert-watcher', daemon=True)
        self._thread.start()
        self.logger.info(f"Alert watcher started ({len(self.rules)} rule(s))")

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)
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
