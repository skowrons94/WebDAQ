# run.py
import os
import signal
import sys
import logging
from waitress import serve
from app import create_app, db
from app.models.user import User
from app.models.run_metadata import RunMetadata

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = create_app()

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
    Stops acquisition, threads, and Docker containers gracefully.
    
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
            
            # Stop acquisition if running
            if daq_mgr.is_running():
                logger.info("Stopping DAQ acquisition...")
                daq_mgr.stop_xdaq()
                daq_mgr.set_running_state(False)
            
            # Stop board monitoring thread
            logger.info("Stopping board monitoring...")
            daq_mgr.stop_board_monitoring()
            
            # Stop Docker container
            logger.info("Stopping Docker container...")
            if hasattr(daq_mgr, 'container') and daq_mgr.container:
                daq_mgr.container.stop()
            
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
    
    # Exit
    os._exit(0)

if __name__ == '__main__':
    # Register signal handlers for clean shutdown
    signal.signal(signal.SIGINT, cleanup_on_shutdown)   # CTRL+C
    signal.signal(signal.SIGTERM, cleanup_on_shutdown)  # Termination signal
    
    logger.info("Starting WebDAQ server with clean shutdown handlers...")
    logger.info("Press CTRL+C for clean shutdown")
    
    try:
        serve(app, host='0.0.0.0', port=5001, threads=10)
    except KeyboardInterrupt:
        cleanup_on_shutdown(signal.SIGINT)
    except Exception as e:
        logger.error(f"Server error: {e}")
        cleanup_on_shutdown()
