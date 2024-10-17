import os
import gc
import time
import ROOT

import threading
import time

class ru_spy:
    def __init__(self, host='localhost', port=6060):
        self.host = host
        self.port = port
        self.socket = None
        self.running = False
        self.thread = None
        self.data = { "energy": [], "qshort": [], "qlong": [], "wave1": [], "wave2": [] }
        self.histo = ROOT.TH1F("Histogram", "Histogram", 32768, 0, 32768)

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
        msg = ROOT.TMessage()
        if self.socket.Recv(msg) <= 0:
            return False
        
        if msg.GetClass().GetName() in ["TH1F"]:
            obj = msg.ReadObject(msg.GetClass())
            msg.Delete()
            return obj
        
        return False
        
    def start(self, state):
        cmd = "LunaSpy"
        for board in state['boards']:
            firmware = 0 if board['dpp'] == "DPP-PHA" else 1
            cmd += f" -d {board['name']} {firmware} {board['chan']}"
        cmd += f" -n {state['run']}"
        os.system(f"{cmd} &")
        
        time.sleep(1)
        
        self.running = True
        if( self.thread != None ): self.thread.join()
        self.thread = threading.Thread(target=self.run)
        self.thread.start()

    def delete(self, array):
        if( array == None ): return
        if( len(array) == 0 ): return
        for obj in array:
            obj.Delete()

    def free(self, dict):
        for key in dict.keys():
            self.delete(dict[key])
            dict[key] = []

    def run(self):

        while self.running:
            self.connect()
            self.send("get")
            buff = { "energy": [], "qshort": [], "qlong": [], "wave1": [], "wave2": [] }
            try:
                while True:
                    obj = self.receive()
                    if( obj == False ): break
                    if "Wave1" in obj.GetName():
                        buff["wave1"].append(obj)
                    elif "Wave2" in obj.GetName():
                        buff["wave2"].append(obj)
                    elif "Qshort" in obj.GetName():
                        buff["qshort"].append(obj)
                    elif "Qlong" in obj.GetName():
                        buff["qlong"].append(obj)
                    elif "Energy" in obj.GetName():
                        buff["energy"].append(obj)
                    else: pass
            except Exception as e:
                print(f"Error receiving histogram: {e}")

            with threading.Lock():
                for key in buff.keys():
                    self.free(self.data)
                    for key in buff.keys():
                        for obj in buff[key]:
                            self.data[key].append(obj.Clone())
            self.free(buff)

            self.disconnect()
            time.sleep(1)  # Wait for 1 second before next acquisition

    def stop(self):
        self.running = False
        self.thread.join()
        self.thread = None

        try:
            self.connect()
            self.send("stop")
            self.disconnect()
        except:
            os.system("killall LunaSpy")
    
    def get_object(self, name, idx):
        try:
            return self.data[name][idx].Clone( )
        except:
            return self.histo