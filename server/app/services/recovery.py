"""
Recovery — the fix offered next to the problem.

An alert that says "board 1 stopped reading" leaves the operator to work out what
to press, usually by asking someone who knows. This module names the handful of
things that actually recover a DAQ session, reports whether each one is currently
needed, and runs it on request:

    boards      reopen the digitizer connections (after a link glitch)
    acquisition reset the acquisition (after a failed or wedged run)
    current     reconnect the beam-current monitor
    stats       restart the statistics collection for the current run
    graphite    re-check the Graphite server

Nothing here runs by itself. The operator presses it, so a recovery never happens
behind their back in the middle of a measurement — the one exception in WebDAQ is
auto-restart, which is opt-in and says so. Every action reports what it did in
words that can go straight into the UI, and refuses when it would do harm (no
reopening boards mid-run, no restarting statistics without a run).
"""

import logging
import os
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

# os.getenv returns strings: 'False' is truthy, which would run a shift against
# the mock hardware. Read it the way the rest of the server means it.
TEST_FLAG = str(os.getenv('TEST_FLAG', '')).strip().lower() in ('1', 'true', 'yes', 'on')


def _daq():
    from .daq_manager import get_daq_manager
    return get_daq_manager(test_flag=TEST_FLAG)


def _current_module():
    from ..routes import current as current_routes
    return current_routes


def _stats_manager():
    from ..routes.stats import stats_manager
    return stats_manager


# ── state: what is wrong right now ───────────────────────────────────────────

def _boards_state() -> Dict[str, Any]:
    daq = _daq()
    try:
        connectivity = daq.check_board_connectivity()
    except Exception as e:
        return {'ok': False, 'detail': f'Board connectivity is unknown: {e}'}
    if not connectivity:
        return {'ok': True, 'detail': 'No boards configured.'}
    closed = [bid for bid, s in connectivity.items() if not s.get('connected')]
    failed = [bid for bid, s in connectivity.items() if s.get('failed')]
    if closed:
        return {'ok': False,
                'detail': f"Board(s) {', '.join(sorted(closed))} are disconnected."}
    if failed:
        # The flags belong to the run that raised them; between runs they are
        # history, not a problem with the boards right now.
        when = 'during this run' if daq.is_running() else 'during the last run'
        return {'ok': daq.is_running() is False,
                'detail': f"Board(s) {', '.join(sorted(failed))} raised the FAIL flag "
                          f"{when}."}
    return {'ok': True, 'detail': f'All {len(connectivity)} board(s) connected.'}


def _current_state() -> Dict[str, Any]:
    module = _current_module()
    controller = module.controller
    if controller is None:
        return {'ok': False, 'detail': 'No beam-current monitor is configured.'}
    try:
        if not controller.is_connected():
            return {'ok': False, 'detail': 'The beam-current monitor is not connected.'}
    except Exception as e:
        return {'ok': False, 'detail': f'The beam-current monitor cannot be reached: {e}'}
    from .alerting import _live_beam_current
    if _live_beam_current() is None:
        return {'ok': False,
                'detail': 'The monitor is connected but has produced no recent reading.'}
    return {'ok': True, 'detail': 'The beam-current monitor is reading.'}


def _stats_state() -> Dict[str, Any]:
    daq, stats = _daq(), _stats_manager()
    collecting = bool(getattr(stats, 'collecting', False))
    if not daq.is_running():
        if collecting:
            return {'ok': False,
                    'detail': f'Statistics are still being collected for run '
                              f'{stats.current_run_number} although no run is active — '
                              'the rows are going into that run\'s file.'}
        return {'ok': True, 'detail': 'Statistics run with the run; none is active.'}
    if not daq.get_save_data():
        return {'ok': True, 'detail': 'This run saves no data, so no stats.csv is written.'}
    if collecting:
        return {'ok': True, 'detail': f'Writing stats.csv for run {stats.current_run_number}.'}
    return {'ok': False, 'detail': 'This run is saving data but no stats.csv is being written.'}


def _graphite_state() -> Dict[str, Any]:
    try:
        from ..utils.graphite import GraphiteClient   # noqa: F401  (import check)
        stats = _stats_manager()
        client = stats.graphite_client
        reachable = bool(client.check_connection())
    except Exception as e:
        return {'ok': False, 'detail': f'The Graphite server could not be checked: {e}'}
    where = f"{getattr(client, 'host', '?')}:{getattr(client, 'port', '?')}"
    return ({'ok': True, 'detail': f'Graphite at {where} is answering.'} if reachable else
            {'ok': False, 'detail': f'Graphite at {where} is not answering.'})


# ── actions: the fix ─────────────────────────────────────────────────────────

def _reopen_boards() -> Dict[str, Any]:
    daq = _daq()
    if daq.is_running():
        return {'success': False,
                'message': 'A run is in progress. Stop it before reopening the boards.'}
    boards = daq.get_boards()
    if not boards:
        return {'success': False, 'message': 'No boards are configured.'}
    reopened, failed = 0, []
    for board in boards:
        if daq.refresh_board_connection(str(board['id'])):
            reopened += 1
        else:
            failed.append(str(board['id']))
    if failed:
        return {'success': False,
                'message': f"Reopened {reopened}/{len(boards)} board(s); "
                           f"board(s) {', '.join(failed)} stayed shut."}
    return {'success': True, 'message': f'Reopened {reopened} board connection(s).'}


def _reset_acquisition() -> Dict[str, Any]:
    daq = _daq()
    try:
        from .spy_manager import get_spy_manager
        get_spy_manager(test_flag=TEST_FLAG).stop_spy()
    except Exception as e:
        logger.debug(f"recovery: spy stop: {e}")
    if daq.reset_acquisition():
        return {'success': True,
                'message': 'Acquisition reset: the boards are closed, reopened and idle.'}
    return {'success': False,
            'message': 'The acquisition could not be reset — see server.log.'}


def _reconnect_current() -> Dict[str, Any]:
    module = _current_module()
    controller = module.controller
    if controller is None:
        return {'success': False, 'message': 'No beam-current monitor is configured.'}
    try:
        controller.initialize()
    except Exception as e:
        return {'success': False, 'message': f'The monitor did not answer: {e}'}
    try:
        connected = controller.is_connected()
    except Exception as e:
        return {'success': False, 'message': f'The monitor did not answer: {e}'}
    return ({'success': True, 'message': 'The beam-current monitor is connected again.'}
            if connected else
            {'success': False, 'message': 'The monitor is still not connected.'})


def _keep_existing_stats_file(run_number: int) -> str:
    """Move an existing stats.csv aside, and say where it went.

    Starting a statistics run opens stats.csv for writing, so restarting one
    mid-run would erase everything the run had already recorded. The rows already
    on disk are measurements: they are kept as stats.csv.part1, part2, … and the
    analysis can concatenate them.
    """
    path = os.path.join('data', f'run{run_number}', 'stats.csv')
    if not os.path.exists(path):
        return ''
    for index in range(1, 100):
        candidate = f'{path}.part{index}'
        if not os.path.exists(candidate):
            try:
                os.replace(path, candidate)
            except OSError as e:
                logger.error(f"recovery: could not keep {path}: {e}")
                return ''
            return os.path.basename(candidate)
    return ''


def _restart_stats() -> Dict[str, Any]:
    daq, stats = _daq(), _stats_manager()
    if not daq.is_running():
        return {'success': False,
                'message': 'Statistics belong to a run, and no run is active.'}
    if not daq.get_save_data():
        return {'success': False, 'message': 'This run saves no data, so there is no stats.csv.'}
    run_number = daq.get_run_number()
    if getattr(stats, 'collecting', False):
        stats.stop_run()
    existing = os.path.join('data', f'run{run_number}', 'stats.csv')
    had_file = os.path.exists(existing)
    kept = _keep_existing_stats_file(run_number)
    if had_file and not kept:
        # Starting a statistics run opens stats.csv for writing. Rather than
        # truncate measurements we cannot move aside, refuse and say why.
        return {'success': False,
                'message': f'The statistics of run {run_number} could not be moved aside, '
                           'so they were left alone rather than overwritten. Check the '
                           'permissions on the run directory (see server.log).'}
    if stats.start_run(run_number):
        message = f'Statistics restarted for run {run_number}.'
        if kept:
            message += (f' What had been collected is kept as {kept}, and the run '
                        'report reads it together with the new file.')
        return {'success': True, 'message': message}
    return {'success': False, 'message': 'The statistics collection did not start.'}


def _recheck_graphite() -> Dict[str, Any]:
    stats = _stats_manager()
    client = stats.graphite_client
    try:
        # A breaker opened by an earlier outage would answer from memory.
        if hasattr(client, 'reset_breaker'):
            client.reset_breaker()
        reachable = bool(client.check_connection())
    except Exception as e:
        return {'success': False, 'message': f'Graphite could not be checked: {e}'}
    where = f"{getattr(client, 'host', '?')}:{getattr(client, 'port', '?')}"
    return ({'success': True, 'message': f'Graphite at {where} is answering again.'}
            if reachable else
            {'success': False, 'message': f'Graphite at {where} is still not answering.'})


# name -> (label, what it does, when it is offered, state probe, action)
_ACTIONS: Dict[str, Dict[str, Any]] = {
    'boards': {
        'label': 'Reopen the boards',
        'description': 'Close and reopen every digitizer connection. Use after a link '
                       'glitch or when a board reads as disconnected.',
        'available_while_running': False,
        'state': _boards_state,
        'run': _reopen_boards,
    },
    'acquisition': {
        'label': 'Reset the acquisition',
        'description': 'Stop whatever the acquisition is doing and bring the boards back '
                       'to idle. Use after a failed or wedged run.',
        'available_while_running': False,
        'state': lambda: {'ok': not _daq().is_running(),
                          'detail': 'A run is in progress.' if _daq().is_running()
                                    else 'Idle.'},
        'run': _reset_acquisition,
    },
    'current': {
        'label': 'Reconnect the current monitor',
        'description': 'Re-open the beam-current monitor. Use when the current reads as '
                       'disconnected or stops updating.',
        'available_while_running': True,
        'state': _current_state,
        'run': _reconnect_current,
    },
    'stats': {
        'label': 'Restart the statistics',
        'description': 'Start writing stats.csv for the current run again. Use when the '
                       'metrics stopped being recorded mid-run.',
        'available_while_running': True,
        'state': _stats_state,
        'run': _restart_stats,
    },
    'graphite': {
        'label': 'Re-check Graphite',
        'description': 'Test the Graphite server and clear the "unavailable" state that '
                       'an outage leaves behind.',
        'available_while_running': True,
        'state': _graphite_state,
        'run': _recheck_graphite,
    },
}


def actions() -> List[Dict[str, Any]]:
    """Every recovery action, with whether its subsystem currently looks healthy."""
    running = _daq().is_running()
    out = []
    for name, spec in _ACTIONS.items():
        try:
            state = spec['state']()
        except Exception as e:
            state = {'ok': False, 'detail': f'Unknown: {e}'}
        out.append({
            'name': name,
            'label': spec['label'],
            'description': spec['description'],
            'ok': bool(state.get('ok')),
            'detail': state.get('detail', ''),
            # Refusing in the UI beats refusing after the click.
            'enabled': bool(spec['available_while_running'] or not running),
            'blocked_reason': ('' if spec['available_while_running'] or not running
                               else 'Not while a run is in progress.'),
        })
    return out


def run_action(name: str) -> Dict[str, Any]:
    """Run one recovery action. Always returns {'success', 'message'}."""
    spec = _ACTIONS.get(name)
    if spec is None:
        return {'success': False, 'message': f'Unknown recovery action {name!r}.'}
    if not spec['available_while_running'] and _daq().is_running():
        return {'success': False,
                'message': f"'{spec['label']}' is not available while a run is in progress."}
    try:
        result = spec['run']()
    except Exception as e:
        logger.error(f"Recovery action {name} failed: {e}", exc_info=True)
        result = {'success': False, 'message': f'{spec["label"]} failed: {e}'}

    # The log is what a shift reads later; a recovery someone performed belongs in
    # it just as much as the alert that prompted it.
    try:
        from .alert_log import get_alert_log
        get_alert_log().record(
            # A failed recovery is a problem, and belongs where problems are read.
            'recovery' if result.get('success') else 'alert',
            f"{spec['label']}: {'done' if result.get('success') else 'failed'}",
            [result.get('message', '')], subject=name)
    except Exception as e:
        logger.debug(f"recovery: could not log {name}: {e}")
    return result
