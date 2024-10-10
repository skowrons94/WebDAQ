import socket
import struct
import threading
import time
import os
from datetime import datetime

class TetrAMMController:
    def __init__(self, ip='192.168.0.10', port=10001):
        self.ip = ip
        self.port = port
        self.socket = None
        self.acquisition_thread = None
        self.is_acquiring = False
        self.save_data = False
        self.save_folder = ''
        self.buffer = b''
        self.lock = threading.Lock()

    def connect(self):
        self.socket = socket.socket()
        self.socket.settimeout(2.0)
        self.socket.connect((self.ip, self.port))

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
        if self.is_acquiring:
            self.stop_acquisition()
        response = self._send_command(f'{setting}:{value}')
        self.start_acquisition()
        return response

    def get_setting(self, setting):
        if self.is_acquiring:
            self.stop_acquisition()
        response = self._send_command(f'{setting}:?')
        self.start_acquisition()
        return response

    def start_acquisition(self):
        if not self.is_acquiring:
            self.is_acquiring = True
            self._send_command('ACQ:ON')
            self.acquisition_thread = threading.Thread(target=self._acquisition_loop)
            self.acquisition_thread.start()

    def stop_acquisition(self):
        if self.is_acquiring:
            self.is_acquiring = False
            self._send_command('ACQ:OFF')
            self.acquisition_thread.join()

    def _acquisition_loop(self):
        while self.is_acquiring:
            try:
                data = self.socket.recv(40)
                with self.lock:
                    self.buffer += data
                if self.save_data:
                    self._save_buffer()
            except socket.timeout:
                print("Timeout occurred for TetrAMM")
                pass

    def _save_buffer(self):
        if not os.path.exists(self.save_folder):
            os.makedirs(self.save_folder)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = os.path.join(self.save_folder, f'data_{timestamp}.bin')
        with open(filename, 'wb') as f:
            f.write(self.buffer)
        self.buffer = b''

    def set_save_data(self, save_data, save_folder=''):
        self.save_data = save_data
        self.save_folder = save_folder

    def get_data(self):
        with self.lock:
            data = self.buffer
            self.buffer = b''
        return struct.unpack('>' + 'd' * (len(data) // 8), data)

    def reset(self):
        self.disconnect()
        self.connect()
        self.start_acquisition()