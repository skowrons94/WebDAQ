import socket
import threading
import time
import json
import os

import numpy as np

from datetime import datetime

class tetram_controller:
    def __init__(self, ip='169.254.145.10', port=10001, graphite_host='172.18.9.54', graphite_port=2003):
        self.ip = ip
        self.port = port
        self.graphite_host = graphite_host
        self.graphite_port = graphite_port
        self.socket = None
        self.acquisition_thread = None
        self.is_acquiring = False
        self.save_data = False
        self.save_folder = ''
        self.buffer = b''
        self.start = 0
        self.times = np.zeros(100000)
        self.values = { "0": np.zeros(100000), "1": np.zeros(100000), "2": np.zeros(100000), "3": np.zeros(100000) }
        self.lock = threading.Lock()
        self.load_settings()

    def set_ip(self, ip):
        self.ip = ip

    def set_port(self, port):
        self.port = port

    def is_connected(self):
        if self.is_acquiring:
            return True
        return False

    def send_metric(self, metric_path, value, timestamp):
        # Create a socket connection to the Graphite server
        try:
            # Open a socket to Graphite
            sock = socket.create_connection((self.graphite_host, self.graphite_port))
            
            # Prepare the metric in the format: metric_path value timestamp
            message = f"{metric_path} {value} {timestamp}\n"
            
            # Send the message to Graphite
            sock.sendall(message.encode('utf-8'))
            
        except Exception as e:
            pass
        finally:
            # Ensure the socket is closed properly
            if 'sock' in locals():
                sock.close()

    def initialize(self):
        try:
            self.connect()
            for setting, value in self.settings.items():
                self.set_setting(setting, value)
            self.start_acquisition()
        except Exception as e:
            print(f"Failed to initialize TetrAMM: {e}")

    def write_settings(self):
        with open('conf/tetram.json', 'w') as f:
            json.dump(self.settings, f)

    def load_settings(self):
        if not os.path.exists('conf/tetram.json'):
            self.settings = { 'CHN': "1", 'RNG': "AUTO", 'ASCII': "ON", 'NRSAMP': "10000", 'TRG': "OFF", 'NAQ': "1" }
            self.write_settings()
        else:
            with open('conf/tetram.json', 'r') as f:
                self.settings = json.load(f)

    def connect(self):
        self.socket = socket.socket()
        self.socket.settimeout(2.0)
        self.socket.connect((self.ip, int(self.port)))

    def disconnect(self):
        if self.is_acquiring:
            self.stop_acquisition()
        if self.socket:
            self.socket.close()
            self.socket = None

    def _send_command(self, command):
        self.socket.send(f'{command}\r'.encode())
        return self.socket.recv(1024)

    def set_setting(self, setting, value):
        if( setting in self.settings ):
            self.settings[setting] = value
            self.write_settings()
        else:
            return -1
        if self.is_acquiring:
            self.stop_acquisition()
        response = self._send_command(f'{setting}:{value}')
        response = response.decode().split( )[0]
        self.start_acquisition()
        return response

    def get_setting(self, setting):
        if self.is_acquiring:
            self.stop_acquisition()
        response = self._send_command(f'{setting}:?')
        response = response.decode()
        response = response.split(':')[1][:-2]
        self.start_acquisition()
        return response

    def start_acquisition(self):
        if not self.is_acquiring:
            self.is_acquiring = True
            self.acquisition_thread = threading.Thread(target=self._acquisition_loop)
            self.acquisition_thread.start()

    def stop_acquisition(self):
        if self.is_acquiring:
            self.is_acquiring = False
            self.acquisition_thread.join()
            while( True ):
                try:
                    recv = self.socket.recv(1024)
                    if recv[-5:] == b'ACK\r\n':
                        break
                except:
                    break

    def _acquisition_loop(self):
        while self.is_acquiring:
            try:
                data = self._send_command('ACQ:ON')
                data = data.decode().split( )
                if( data[0] == 'ACK' ):
                    continue
                now = datetime.now()
                timestamp = now.timestamp()
                with self.lock:
                    for i in range(int(self.settings['CHN'])):
                        self.values[str(i)] = np.roll(self.values[str(i)], -1)
                        self.values[str(i)][-1] = float(data[i]) * 1e6 # Convert to uA
                    self.times = np.roll(self.times, -1)
                    self.times[-1] = timestamp
                    for i in range(int(self.settings['CHN'])):
                        self.send_metric(f"tetram.ch{i}", self.values[str(i)][-1], timestamp)
                    print(self.save_data)
                    if( self.save_data ):
                        with open(os.path.join(self.save_folder, f'current.txt'), 'a') as f:
                            f.write(f'{timestamp - self.start:.2e}\t')
                            for i in range(int(self.settings['CHN'])):
                                f.write(f'{self.values[str(i)][-1]:.2e}\t')
                            f.write('\n')
                time.sleep(0.5)
            except socket.timeout:
                data = self._send_command('ACQ:OFF')
                pass

    def set_save_data(self, save_data, save_folder=''):
        with self.lock:
            self.start = datetime.now().timestamp()
            # Write header to file
            if( save_data ):
                with open(os.path.join(save_folder, 'current.txt'), 'w') as f:
                    f.write(f'### Start time: {datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")} ###\n')
            self.save_data = save_data
            self.save_folder = save_folder

    def get_data_array(self):
        with self.lock:
            return { "0" : self.values["0"][-101:-1], "1" : self.values["1"][-101:-1][-1], "2" : self.values["2"][-101:-1][-1], "3" : self.values["3"][-101:-1][-1] }

    def get_data(self):
        with self.lock:
            return { "0" : self.values["0"][-1], "1" : self.values["1"][-1], "2" : self.values["2"][-1], "3" : self.values["3"][-1] }

    def reset(self):
        if( self.is_acquiring ):
            self.stop_acquisition()
            time.sleep(0.5)
        self.disconnect()
        time.sleep(0.5)
        self.initialize()

    def check_thread(self):
        if self.acquisition_thread:
            if self.acquisition_thread.is_alive():
                return True
        return False
