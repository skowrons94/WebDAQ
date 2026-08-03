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
"""

import errno
import logging
import os
import socket
from typing import Optional

logger = logging.getLogger(__name__)

# Written next to the code, not the working directory: one machine drives one
# set of digitizers, so "is a backend already running here" is a question about
# the installation, not about which experiment directory it was started from.
PID_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), 'cache', 'daq-server.pid')

DEFAULT_PORT = 5001


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


def refuse_if_already_running(port: int = DEFAULT_PORT,
                              pid_file: str = PID_FILE) -> Optional[str]:
    """
    Check for another backend, and return an explanatory message if there is one.

    Returns None when it is safe to continue. The caller is expected to print
    the message and exit non-zero — this function does not exit, so that it can
    be tested and so the decision stays visible at the call site.
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
    """Record our pid so kill-server.sh and the guard above can find us."""
    try:
        os.makedirs(os.path.dirname(pid_file), exist_ok=True)
        with open(pid_file, 'w') as f:
            f.write(str(os.getpid()))
    except OSError as e:
        logger.debug(f"could not write pid file: {e}")


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
