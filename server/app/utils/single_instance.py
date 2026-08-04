"""
Refuse to start a second backend against the same hardware.

Two WebDAQ servers on one machine is not a case of "the second one loses the
port and gives up". By the time waitress tries to bind, the app has already
been constructed, and constructing it opens the CAEN digitizers over USB and
the picoammeter socket — so the losing instance has already reached into a
running acquisition. It then hits EADDRINUSE, falls into the generic error
path, and calls cleanup_on_shutdown(), which stops acquisition and closes
digitizer handles for the hardware the FIRST server is still using. It also
rewrites the pid file on the way in and deletes it on the way out, leaving the
real server untracked and kill-server.sh pointing at nothing.

So the check has to happen before anything is imported that talks to hardware,
which is why this lives in its own module: main.py calls it at the very top,
above its own application imports.

Two independent signals, because either alone has a blind spot:

  * the pid file, which is definitive when present and verifiable, but is
    deleted on clean shutdown and can be stale after a SIGKILL; and
  * the listening port, which catches a server whose pid file was lost or
    removed by hand.

Finding the obstacle is only half of it. Detecting one and telling the operator
to go and run a script is a dead end for anyone who does not know the codebase,
and the usual obstacle — a backend left behind by a crash or a restart — is one
we can clear up without asking. ensure_sole_instance() therefore stops a
leftover backend itself and carries on. Two cases still refuse, because neither
is ours to decide: a server that is currently taking data, and a port held by a
process that is not a WebDAQ backend at all.
"""

import errno
import json
import logging
import os
import signal
import socket
import time
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

# Written next to the code, not the working directory: one machine drives one
# set of digitizers, so "is a backend already running here" is a question about
# the installation, not about which experiment directory it was started from.
PID_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), 'cache', 'daq-server.pid')

DEFAULT_PORT = 5001

# Read to tell a leftover process apart from a server that is mid-run. Relative,
# like everywhere else in the app: it names the experiment directory the server
# was started from.
SETTINGS_FILE = os.path.join('conf', 'settings.json')

# How long a backend gets to shut down cleanly before it is killed outright.
# Its own shutdown stops acquisition and closes the digitizer handles, which is
# exactly what we want to happen before we open them ourselves.
STOP_TIMEOUT = 15.0


def _is_webdaq_process(pid: int) -> bool:
    """
    Whether a pid really is a WebDAQ backend.

    PIDs are recycled, and a stale pid file that happens to name some unrelated
    process would otherwise lock the operator out of starting the server at all.
    Checked against the command line; on a system without /proc we cannot tell,
    and answer True so that the safe outcome (refuse, and say why) wins over
    silently starting a second server on the same digitizers.
    """
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as f:
            cmdline = f.read().replace(b'\0', b' ').decode('utf-8', 'replace')
    except FileNotFoundError:
        return False          # /proc exists, this pid does not: gone
    except OSError:
        return True           # cannot inspect: assume the worst
    return 'main.py' in cmdline


def running_server_pid(pid_file: str = PID_FILE) -> Optional[int]:
    """
    The pid of a live backend recorded in the pid file, or None.

    None covers every "no obstacle" case: no file, unreadable, garbage, our own
    pid, a dead process, or a live process that is something else entirely.
    """
    try:
        with open(pid_file) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return None

    if pid <= 0 or pid == os.getpid():
        return None

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None                     # stale file, process is gone
    except PermissionError:
        pass                            # alive, owned by someone else
    except OSError:
        return None

    return pid if _is_webdaq_process(pid) else None


def port_in_use(port: int = DEFAULT_PORT) -> bool:
    """
    Whether something already holds the backend's port.

    Catches a running server whose pid file was lost. A test bind rather than a
    connect: a connect would also succeed against something that is merely
    listening on the same port for other reasons, and would race with a server
    that is starting up.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Deliberately NOT SO_REUSEADDR: we want this to fail exactly when
        # waitress's own bind would fail.
        probe.bind(('0.0.0.0', port))
        return False
    except OSError as e:
        return e.errno in (errno.EADDRINUSE, errno.EACCES)
    finally:
        probe.close()


def _command_line(pid: int) -> str:
    """A process's command line, for naming it in a message. '' if unreadable."""
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as f:
            return f.read().replace(b'\0', b' ').decode('utf-8', 'replace').strip()
    except OSError:
        return ''


def _describe(pid: int) -> str:
    command = _command_line(pid)
    return f"pid {pid} ({command})" if command else f"pid {pid}"


def _listening_inodes(port: int) -> set:
    """Socket inodes of everything LISTENing on `port`, from /proc/net."""
    inodes = set()
    for path in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            with open(path) as f:
                next(f, None)                       # column headers
                for line in f:
                    fields = line.split()
                    if len(fields) < 10 or fields[3] != '0A':   # 0A = TCP_LISTEN
                        continue
                    try:
                        if int(fields[1].rsplit(':', 1)[1], 16) == port:
                            inodes.add(fields[9])
                    except (IndexError, ValueError):
                        continue
        except OSError:
            continue
    return inodes


def pids_listening_on(port: int = DEFAULT_PORT) -> List[int]:
    """
    The pids holding `port` open.

    Walks /proc rather than shelling out to lsof or ss, neither of which is
    guaranteed to be installed on a control-room machine. Returns [] when
    nothing holds the port or when /proc cannot be read — the caller treats
    "could not identify" and "nothing there" differently, so this never guesses.
    """
    inodes = _listening_inodes(port)
    if not inodes:
        return []

    targets = {f'socket:[{inode}]' for inode in inodes}
    pids: List[int] = []
    try:
        entries = os.listdir('/proc')
    except OSError:
        return []

    for entry in entries:
        if not entry.isdigit():
            continue
        fd_dir = f'/proc/{entry}/fd'
        try:
            descriptors = os.listdir(fd_dir)
        except OSError:
            continue            # gone, or another user's process
        for fd in descriptors:
            try:
                if os.readlink(os.path.join(fd_dir, fd)) in targets:
                    pids.append(int(entry))
                    break
            except OSError:
                continue
    return pids


def acquisition_in_progress(settings_file: str = SETTINGS_FILE) -> bool:
    """
    Whether the experiment directory says a run is being taken.

    The server maintains this flag, so together with a live process it is the
    difference between a leftover worth reaping and a run worth protecting.
    Unreadable or absent means "no claim", so a missing file never blocks a
    start.
    """
    try:
        with open(settings_file) as f:
            return bool(json.load(f).get('running'))
    except (OSError, ValueError, AttributeError):
        return False


def stop_process(pid: int, timeout: float = STOP_TIMEOUT) -> bool:
    """
    Ask a process to stop, then insist. True once it is gone.

    SIGTERM first, because the backend's own handler stops acquisition and
    releases the digitizers; SIGKILL only if it will not go, which leaves the
    USB handles to be cleaned up by the kernel.
    """
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except OSError as e:
        logger.warning(f"Could not signal pid {pid}: {e}")
        return False

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(0.2)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except OSError:
            return True                 # not ours to probe; assume it went

    logger.warning(f"pid {pid} ignored SIGTERM after {timeout:.0f}s — sending SIGKILL")
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass

    for _ in range(10):
        time.sleep(0.2)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except OSError:
            return True
    return False


def _wait_for_free_port(port: int, timeout: float = 5.0) -> bool:
    """Poll until the port can be bound: a closing listener is not instant."""
    deadline = time.monotonic() + timeout
    while True:
        if not port_in_use(port):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.25)


def _clear_pid_file(pid_file: str, pids: List[int]) -> None:
    """Drop a pid file that names a process we have just stopped."""
    try:
        with open(pid_file) as f:
            owner = int(f.read().strip())
    except (OSError, ValueError):
        return
    if owner in pids:
        try:
            os.remove(pid_file)
        except OSError:
            pass


def ensure_sole_instance(port: int = DEFAULT_PORT,
                         pid_file: str = PID_FILE,
                         force: bool = False,
                         settings_file: str = SETTINGS_FILE) -> Optional[str]:
    """
    Clear the way for this server, or explain why it cannot start.

    Refusing and naming a script to run was a dead end for anyone who does not
    know the codebase, and the overwhelmingly common case — a backend left over
    from a crash or a restart — is one we can simply clean up. So a leftover
    WebDAQ backend is stopped automatically, and only two things still refuse:

      * a run in progress, where killing the server would throw away data. Set
        WEBDAQ_FORCE_RESTART=1 (or pass --force) to override deliberately.
      * a port held by something that is not ours, which we will not kill.

    Returns None when it is safe to continue, otherwise a message for the
    operator. Never exits; the decision stays visible at the call site.
    """
    blockers: List[int] = []
    foreign: List[int] = []
    for holder in pids_listening_on(port):
        if holder == os.getpid():
            continue
        (blockers if _is_webdaq_process(holder) else foreign).append(holder)

    recorded = running_server_pid(pid_file)
    if recorded is not None and recorded not in blockers and recorded not in foreign:
        blockers.append(recorded)

    if foreign:
        return (
            f"Port {port} is held by another program, not a WebDAQ backend:\n"
            f"  {', '.join(_describe(p) for p in foreign)}\n"
            f"WebDAQ will not kill a process it does not recognise. Stop that "
            f"program and start the server again.")

    if not blockers:
        if not port_in_use(port):
            return None
        # Something holds the port but /proc would not say who — an unprivileged
        # view of another user's process, typically. Killing blind is not an
        # option, so this is one case that still needs a human.
        return (
            f"Port {port} is in use, but the process holding it could not be "
            f"identified, so it was left alone.\n"
            f"server/scripts/kill-server.sh will find it by port.")

    if acquisition_in_progress(settings_file) and not force:
        return (
            f"A WebDAQ backend is already running ({_describe(blockers[0])}) and "
            f"it is taking data.\n"
            f"Stopping it would abandon the run in progress, so it was left "
            f"alone. Stop the run from the dashboard first, or start with "
            f"WEBDAQ_FORCE_RESTART=1 to override.")

    for pid in blockers:
        logger.warning(f"Stopping leftover WebDAQ backend {_describe(pid)} to free port {port}")
        if not stop_process(pid):
            return (
                f"A WebDAQ backend ({_describe(pid)}) is holding port {port} and "
                f"would not stop, even after SIGKILL.\n"
                f"It may be stuck in a driver call. Check it with "
                f"'ps -p {pid}' before starting again.")

    _clear_pid_file(pid_file, blockers)

    if not _wait_for_free_port(port):
        return (
            f"The previous backend was stopped, but port {port} is still not "
            f"free.\nWait a moment and start again.")

    logger.warning(f"Reclaimed port {port} from {len(blockers)} leftover backend(s)")
    return None


def refuse_if_already_running(port: int = DEFAULT_PORT,
                              pid_file: str = PID_FILE) -> Optional[str]:
    """
    Report an obstacle without doing anything about it.

    Detection only: ensure_sole_instance() is what the server actually calls,
    and it clears a leftover backend rather than reporting it. This remains for
    callers that want to know the state without changing it.
    """
    pid = running_server_pid(pid_file)
    if pid is not None:
        return (
            f"A WebDAQ backend is already running (pid {pid}).\n"
            f"Starting a second one would open the same digitizers and, when it "
            f"failed to take port {port}, tear down the acquisition the first "
            f"one is running.\n"
            f"Use the running server, or stop it first with "
            f"server/scripts/kill-server.sh")

    if port_in_use(port):
        return (
            f"Port {port} is already in use, so a backend (or something else) "
            f"is already listening.\n"
            f"No pid file names a live server, so this may be a leftover "
            f"process: server/scripts/kill-server.sh will find it by port.")

    return None


def write_pid_file(pid_file: str = PID_FILE) -> None:
    """
    Record our pid so kill-server.sh and the guard above can find us.

    A failure here is not fatal — the port scan finds a running server without
    it — but it is worth saying out loud rather than swallowing: the file lives
    under the source tree, so tidying that directory while the server runs
    leaves it untracked, which is exactly how a live backend comes to look like
    an unidentifiable process holding the port.
    """
    try:
        os.makedirs(os.path.dirname(pid_file), exist_ok=True)
        with open(pid_file, 'w') as f:
            f.write(str(os.getpid()))
    except OSError as e:
        logger.warning(f"Could not write the pid file {pid_file}: {e}")


def remove_pid_file(pid_file: str = PID_FILE) -> None:
    """
    Remove the pid file, but only if it is still ours.

    A process that did not write the current file must not delete it, or a
    mistaken second launch shutting down would leave the real server with no
    pid file at all.
    """
    try:
        with open(pid_file) as f:
            owner = int(f.read().strip())
    except (OSError, ValueError):
        return

    if owner != os.getpid():
        return

    try:
        os.remove(pid_file)
    except OSError:
        pass
