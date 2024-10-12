import time

from ROOT import TSocket, TMessage, TH1F
import threading
import time

class ROOTClient:
    def __init__(self, host='localhost', port=6060):
        self.host = host
        self.port = port
        self.socket = None
        self.running = False
        self.histograms = []
        self.graphs = []
        self.thread = None

    def connect(self):
        self.socket = TSocket(self.host, self.port)
        if not self.socket.IsValid():
            raise ConnectionError(f"Error connecting to {self.host}:{self.port}")
        print(f"Connected to {self.host}:{self.port}")

    def disconnect(self):
        self.socket.Close()
        print(f"Disconnected from {self.host}:{self.port}")

    def send(self, msg):
        if self.socket.Send(msg) <= 0:
            print("Server closed the connection.")
            return False
        return

    def receive(self):
        msg = TMessage()

        if self.socket.Recv(msg) <= 0:
            print("Server closed the connection.")
            return False
        
        if msg.GetClass().GetName() == "TH1F" or msg.GetClass().GetName() == "TGraph":
            obj = msg.ReadObject(msg.GetClass())
            return obj
        
        return False
        
    def start(self):
        time.sleep(1)
        self.running = True
        if( self.thread != None ):
            self.thread.join()
        self.thread = threading.Thread(target=self.run)
        self.thread.start()

    def run(self):

        while self.running:
            histograms, graphs = [], []
            self.connect()
            self.send("get")  # Send message 1 to start the server
            try:
                while True:
                    obj = self.receive()
                    if( obj == False ): break
                    if obj.InheritsFrom("TH1F"):
                        #print("Received histogram")
                        histograms.append(obj)
                    elif obj.InheritsFrom("TGraph"):
                        #print("Received graph")
                        graphs.append(obj)
            except Exception as e:
                print(f"Error receiving histogram: {e}")
                
            self.histograms = histograms.copy()
            self.graphs = graphs.copy()

            self.disconnect()
            time.sleep(1)  # Wait for 1 second before next acquisition

    def stop(self):
        self.running = False
        self.thread.join()
        self.thread = None
        self.connect()
        self.send("stop")