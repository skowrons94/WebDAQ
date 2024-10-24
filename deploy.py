#!/usr/bin/env python3
import os
import subprocess
import sys
import time
import signal
import atexit
from pathlib import Path

class WebDAQDeployer:
    def __init__(self, webdaq_path):
        self.webdaq_path = Path(webdaq_path).resolve()
        self.server_path = self.webdaq_path / 'server'
        self.frontend_path = self.webdaq_path / 'frontend'
        self.processes = []

    def check_prerequisites(self):
        """Check if all required tools are installed"""
        try:
            subprocess.run(['flask', '--version'], capture_output=True, check=True)
            subprocess.run(['npm', '--version'], capture_output=True, check=True)
            subprocess.run(['docker', '--version'], capture_output=True, check=True)
        except subprocess.CalledProcessError as e:
            print(f"Error: Missing prerequisites. Please ensure Flask, npm, and Docker are installed.")
            sys.exit(1)
        except FileNotFoundError as e:
            print(f"Error: {e.filename} not found. Please ensure all prerequisites are installed.")
            sys.exit(1)

    def init_database(self):
        """Initialize the database"""
        print("Initializing database...")
        commands = [
            ['flask', 'db', 'init'],
            ['flask', 'db', 'migrate', '-m', 'Initial migration.'],
            ['flask', 'db', 'upgrade']
        ]
        
        for cmd in commands:
            try:
                subprocess.run(cmd, cwd=self.server_path, check=True, env=dict(os.environ, FLASK_APP='server'))
            except subprocess.CalledProcessError as e:
                print(f"Error executing {' '.join(cmd)}: {e}")
                sys.exit(1)

    def create_user(self):
        """Create a new user"""
        print("Creating user...")
        try:
            process = subprocess.Popen(
                ['flask', '--app', 'server', 'create-user'],
                cwd=self.server_path,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True
            )
            # You might want to modify this part to automatically provide username/password
            # For now, it will require manual input
            process.communicate()
        except subprocess.CalledProcessError as e:
            print(f"Error creating user: {e}")
            sys.exit(1)

    def start_server(self):
        """Start the Flask server"""
        print("Starting Flask server...")
        server_process = subprocess.Popen(
            ['flask', '--app', 'server', 'run', '-p', '5001'],
            cwd=self.server_path,
            env=dict(os.environ, FLASK_APP='server')
        )
        self.processes.append(server_process)
        return server_process

    def start_frontend(self):
        """Start the frontend development server"""
        print("Installing frontend dependencies...")
        try:
            subprocess.run(['npm', 'install'], cwd=self.frontend_path, check=True)
        except subprocess.CalledProcessError as e:
            print(f"Error installing frontend dependencies: {e}")
            sys.exit(1)

        print("Starting frontend server...")
        frontend_process = subprocess.Popen(
            ['npm', 'run', 'dev'],
            cwd=self.frontend_path
        )
        self.processes.append(frontend_process)
        return frontend_process

    def cleanup(self):
        """Cleanup function to terminate all processes"""
        print("\nShutting down servers...")
        for process in self.processes:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()

    def deploy(self):
        """Main deployment function"""
        self.check_prerequisites()
        self.init_database()
        self.create_user()
        
        # Start servers
        server_process = self.start_server()
        time.sleep(2)  # Give the server some time to start
        frontend_process = self.start_frontend()

        # Register cleanup function
        atexit.register(self.cleanup)

        print("\nWebDAQ deployment complete!")
        print("Frontend available at: http://localhost:3000")
        print("Server available at: http://localhost:5001")
        print("\nPress Ctrl+C to stop all servers...")

        try:
            # Wait for both processes
            server_process.wait()
            frontend_process.wait()
        except KeyboardInterrupt:
            pass

def main():
    if len(sys.argv) != 2:
        print("Usage: python deploy_webdaq.py <path_to_webdaq_repository>")
        sys.exit(1)

    deployer = WebDAQDeployer(sys.argv[1])
    deployer.deploy()

if __name__ == "__main__":
    main()