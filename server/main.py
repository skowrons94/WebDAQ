# run.py
import os
import signal
import sys
import logging

# Before anything else: creating the app opens the digitizers and the
# picoammeter, so a second launch has already reached into a running
# acquisition by the time waitress discovers the port is taken. The check has
# to happen above these imports, not in __main__ below, because `app =
# create_app()` runs at import time.
if __name__ == '__main__':
    from app.utils.single_instance import refuse_if_already_running

    _conflict = refuse_if_already_running()
    if _conflict:
        print(f"Refusing to start.\n\n{_conflict}", file=sys.stderr)
        sys.exit(1)

from waitress import serve
from app import create_app, db
from app.models.user import User
from app.models.run_metadata import RunMetadata

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = create_app()


def _columns_missing_from_database(flask_app):
    """Columns the models declare that the database does not have.

    Used to decide whether a failed migration is safe to ignore: if nothing is
    missing, the schema is already what the code expects and only the recorded
    revision is wrong. Any error here counts as "cannot verify", which returns a
    non-empty result so the caller reports the failure instead of papering over
    it.
    """
    try:
        from sqlalchemy import inspect as sa_inspect

        with flask_app.app_context():
            inspector = sa_inspect(db.engine)
            existing_tables = set(inspector.get_table_names())
            missing = []
            for table in db.metadata.sorted_tables:
                if table.name not in existing_tables:
                    missing.append(f"{table.name} (whole table)")
                    continue
                have = {c["name"] for c in inspector.get_columns(table.name)}
                for column in table.columns:
                    if column.name not in have:
                        missing.append(f"{table.name}.{column.name}")
            return missing
    except Exception as e:
        return [f"could not inspect the database ({e})"]


def ensure_schema_current(flask_app) -> None:
    """
    Bring the database schema up to date with the code before serving.

    The server is often run from a working directory that holds its own app.db
    (and its own conf/, data/, calib/), while the code — and therefore the
    models — come from the repository. Upgrading only the repository's database
    then leaves the one actually in use behind, and every request touching the
    missing columns fails with "no such column" *after* the acquisition has
    already started, which is a confusing half-broken state.

    Alembic upgrades are idempotent, so running this on every start is cheap and
    makes the schema follow the code automatically. The migrations directory is
    taken from next to this file, not the working directory, so the revisions
    applied always match the models being imported.

    Set WEBDAQ_SKIP_DB_UPGRADE=1 to opt out (e.g. for a shared database managed
    elsewhere).
    """
    if os.getenv("WEBDAQ_SKIP_DB_UPGRADE", "").strip().lower() in ("1", "true", "yes"):
        logger.info("Skipping the database schema check (WEBDAQ_SKIP_DB_UPGRADE set)")
        return

    from flask_migrate import upgrade as alembic_upgrade, stamp as alembic_stamp

    migrations_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "migrations")
    if not os.path.isdir(migrations_dir):
        logger.warning(f"No migrations directory at {migrations_dir} — skipping schema check")
        return

    database = flask_app.config.get("SQLALCHEMY_DATABASE_URI", "?")

    # Alembic's env.py applies the logging configuration from alembic.ini, which
    # sets the root logger to WARN. In-process that would silence the server's
    # own INFO logging for the rest of the run, so put logging back afterwards.
    root_logger = logging.getLogger()
    saved_level = root_logger.level
    saved_handlers = root_logger.handlers[:]

    failure = None
    healed = None
    try:
        with flask_app.app_context():
            try:
                alembic_upgrade(directory=migrations_dir)
            except Exception as e:
                # The schema can already be correct while the revision stamp
                # says otherwise (two servers starting at once, a manual upgrade
                # racing this one, a restored database). Alembic then tries to
                # re-apply a migration and fails — every start, for ever. If the
                # tables genuinely match the models, record the revision and
                # carry on rather than making the operator fix it by hand.
                missing = _columns_missing_from_database(flask_app)
                if missing:
                    raise
                alembic_stamp(directory=migrations_dir)
                healed = str(e).splitlines()[0]
    except Exception as e:
        failure = e
    finally:
        root_logger.handlers[:] = saved_handlers
        root_logger.setLevel(saved_level)

    # Reported only after logging has been restored — otherwise these messages
    # would be swallowed by the configuration Alembic just applied.
    if failure is None:
        if healed:
            logger.warning(
                f"Database schema already matched the models but its migration "
                f"revision was out of step ({healed}) — revision recorded, "
                f"continuing normally.")
        logger.info(f"Database schema is up to date ({database})")
        return

    # Do not abort: the acquisition itself does not need the database, and
    # refusing to start would be worse during a shift. But say loudly what broke
    # and how to fix it, because run metadata will not be recorded.
    logger.error(
        "\n"
        "  ┌──────────────────────────────────────────────────────────────┐\n"
        "  │ DATABASE SCHEMA IS OUT OF DATE                               │\n"
        "  └──────────────────────────────────────────────────────────────┘\n"
        f"  Database : {database}\n"
        f"  Reason   : {failure}\n"
        "  Runs will start, but their metadata will NOT be recorded and the\n"
        "  Logbook and Data pages will fail.\n"
        "  Fix it with:\n"
        f"      flask --app {os.path.dirname(os.path.abspath(__file__))}/app:create_app "
        f"db upgrade --directory {migrations_dir}\n")


# NOTE: deliberately NOT called at import time. `flask --app main.py db ...`
# imports this module, so doing the upgrade here would fire in the middle of the
# very commands meant to manage the database — including scripts/check_db.sh,
# which drives its own upgrade/stamp against a different migrations directory.
# It is invoked from __main__ instead, so it only runs when actually serving.

# Store app reference for use in background threads (e.g., auto-restart)
from app.routes.experiment import set_flask_app
set_flask_app(app)

@app.cli.command("create-user")
def create_user():
    """Create a new user."""
    username = input("Enter username: ")
    email = input("Enter email: ")
    password = input("Enter password: ")
    
    u = User(username=username, email=email)
    u.set_password(password)
    
    db.session.add(u)
    db.session.commit()
    
    print(f"User {username} created successfully!")

@app.shell_context_processor
def make_shell_context():
    return {'db': db, 'User': User, 'RunMetadata': RunMetadata}

def cleanup_on_shutdown(signum=None, frame=None):
    """
    Clean shutdown handler for CTRL+C (SIGINT) and SIGTERM.
    Stops acquisition, background threads and hardware connections gracefully.
    
    Args:
        signum: Signal number (unused but required by signal handler interface)
        frame: Current stack frame (unused but required by signal handler interface)
    """
    logger.info(f"Received signal {signum}, initiating clean shutdown...")
    # frame parameter is unused but required by signal handler interface
    _ = frame
    
    try:
        # Import here to avoid circular imports
        from app.services.daq_manager import get_daq_manager
        from app.services.spy_manager import get_spy_manager
        
        # Get manager instances if they exist
        try:
            daq_mgr = get_daq_manager()

            # Stop the in-process caendaq acquisition if running
            try:
                from app.services.caen_acquisition import get_caen_acquisition
                logger.info("Stopping acquisition...")
                get_caen_acquisition().stop()
            except Exception as e:
                logger.debug(f"acquisition stop: {e}")

            if daq_mgr.is_running():
                daq_mgr.set_running_state(False)

            # Cleanup digitizer connections
            logger.info("Cleaning up digitizer connections...")
            daq_mgr.cleanup()

        except Exception as e:
            logger.warning(f"Error during DAQ cleanup: {e}")
        
        # Stop tetramm current acquisition and close socket
        try:
            from app.routes.current import controller
            if controller and controller.is_connected():
                logger.info("Stopping TetrAMM controller...")
                controller.disconnect()  # This calls stop_acquisition() and closes socket
        except (ImportError, AttributeError, Exception) as e:
            logger.debug(f"No TetrAMM controller to cleanup or error: {e}")
        
        logger.info("Clean shutdown completed")

    except Exception as e:
        logger.error(f"Error during cleanup: {e}")

    _remove_pid_file()
    # Exit
    os._exit(0)


# ---------------------------------------------------------------------------
# Robustness: never orphan the backend, and be easy to kill if left dangling.
# ---------------------------------------------------------------------------
import threading
import time as _time

# PID file so a stray backend is trivial to find/kill (scripts/kill-server.sh),
# and so the guard at the top of this file can tell whether one is already up.
# Removing it is ownership-checked: see app/utils/single_instance.py.
from app.utils.single_instance import (
    remove_pid_file as _remove_pid_file,
    write_pid_file as _write_pid_file,
)


def _launcher_watchdog():
    """Exit the backend if the process that launched it (npm/Next.js, passed as
    LUNA_LAUNCHER_PID) dies — so killing npm always takes the server with it,
    even on SIGKILL. Falls back to detecting reparenting to init (ppid == 1)."""
    launcher = os.environ.get('LUNA_LAUNCHER_PID')
    try:
        launcher = int(launcher) if launcher else None
    except (TypeError, ValueError):
        launcher = None
    orig_ppid = os.getppid()
    while True:
        _time.sleep(2)
        try:
            if launcher is not None:
                os.kill(launcher, 0)          # probe; raises OSError if gone
            # Reparented to init means our direct parent (the launcher) died.
            if orig_ppid != 1 and os.getppid() == 1:
                raise OSError("reparented to init")
        except OSError:
            logger.warning("Launcher process is gone — shutting down backend.")
            cleanup_on_shutdown()             # calls os._exit(0)
            return


if __name__ == '__main__':
    # Only when we are the ones serving: see the note next to the definition.
    ensure_schema_current(app)

    # Register signal handlers for clean shutdown
    signal.signal(signal.SIGINT, cleanup_on_shutdown)   # CTRL+C
    signal.signal(signal.SIGTERM, cleanup_on_shutdown)  # Termination signal

    _write_pid_file()
    threading.Thread(target=_launcher_watchdog, daemon=True).start()

    logger.info(f"Starting WebDAQ server (pid {os.getpid()}) with clean shutdown + launcher watchdog...")
    logger.info("Press CTRL+C for clean shutdown")

    try:
        serve(app, host='0.0.0.0', port=5001, threads=10)
    except KeyboardInterrupt:
        cleanup_on_shutdown(signal.SIGINT)
    except Exception as e:
        logger.error(f"Server error: {e}")
        cleanup_on_shutdown()
