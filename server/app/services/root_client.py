import gc
import time
import ROOT

import threading
import time

class ROOTClient:
    def __init__(self, host='localhost', port=6060):
        self.host = host
        self.port = port
        self.socket = None
        self.running = False
        self.histograms = []
        self.qlong = []
        self.qshort = []
        self.waves1 = []
        self.waves2 = []
        self.thread = None
        self.msg = ROOT.TMessage()

    def connect(self):
        self.socket = ROOT.TSocket(self.host, self.port)
        if not self.socket.IsValid():
            raise ConnectionError(f"Error connecting to {self.host}:{self.port}")

    def disconnect(self):
        self.socket.Close()

    def send(self, msg):
        if self.socket.Send(msg) <= 0: return False
        return

    def receive(self):
        if self.socket.Recv(self.msg) <= 0: return False
        
        if self.msg.GetClass().GetName() in ["TH1F"]:
            obj = self.msg.ReadObject(self.msg.GetClass())
            self.msg.Delete()
            return obj
        
        return False
        
    def start(self):
        time.sleep(1)
        self.running = True
        if( self.thread != None ): self.thread.join()
        self.thread = threading.Thread(target=self.run)
        self.thread.start()

    def clear(self, array):
        if( len(array) == 0 ): return
        for obj in array:
            print(f"Deleting {obj.GetName()}")
            obj.Delete()
            del obj
        return []
    
    def clear_arrays(self):
        if( len(self.histograms) == 0 ): return
        for obj in self.histograms:
            obj.Delete()
            del obj
        self.histograms = []
        if( len(self.waves1) == 0 ): return
        for obj in self.waves1:
            obj.Delete()
            del obj
        self.waves1 = []
        if( len(self.waves2) == 0 ): return
        for obj in self.waves2:
            obj.Delete()
            del obj
        self.waves2 = []
        if( len(self.qshort) == 0 ): return
        for obj in self.qshort:
            obj.Delete()
            del obj
        self.qshort = []
        if( len(self.qlong) == 0 ): return
        for obj in self.qlong:
            obj.Delete()
            del obj
        self.qlong = []
        gc.collect()

    def run(self):

        while self.running:
            histograms, qshort, qlong, waves1, waves2 = [], [], [], [], []
            self.connect()
            self.send("get")
            try:
                while True:
                    obj = self.receive()
                    if( obj == False ): break
                    if "Wave1" in obj.GetName(): waves1.append(obj.Clone())
                    elif "Wave2" in obj.GetName(): waves2.append(obj.Clone())
                    elif "Energy" in obj.GetName(): histograms.append(obj.Clone())
                    elif "Qshort" in obj.GetName(): qshort.append(obj.Clone())
                    elif "Qlong" in obj.GetName(): qlong.append(obj.Clone())
                    else: pass
            except Exception as e:
                print(f"Error receiving histogram: {e}")

            self.histograms = histograms.copy()
            self.qshort = qshort.copy()
            self.qlong = qlong.copy()
            self.waves1 = waves1.copy()
            self.waves2 = waves2.copy()

            self.disconnect()
            time.sleep(1)  # Wait for 1 second before next acquisition
            gc.collect()

    def stop(self):
        self.running = False
        self.thread.join()
        self.thread = None
        self.connect()
        self.send("stop")
        self.disconnect()