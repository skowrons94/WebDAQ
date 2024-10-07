import socket

class FiltersControl:
    _tcp_host=""
    _tcp_port=16161
    _tcp_buffer=1024

    def __init__(self,hostname,hostport):
        self._tcp_host=hostname
        self._tcp_port=hostport

    def connect(self):
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.connect((self._tcp_host,self._tcp_port))

    def disconnect(self):
        self._socket.close()

    def erase_spec(self):
        self.connect()
        self._socket.send("erase")
        self.disconnect()
        print(self._socket.recv(self._tcp_buffer))

    def write_spec(self):
        self.connect()
        self._socket.send("write")
        self.disconnect()
        print(self._socket.recv(self._tcp_buffer))

    def configure_filter(self):
        self.connect()
        self._socket.send("configure")
        self.disconnect()
        print(self._socket.recv(self._tcp_buffer))

