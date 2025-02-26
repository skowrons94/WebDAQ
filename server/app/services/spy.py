import os
import gc
import time
import ROOT

import threading
import time

DEBUG = True

class ru_spy:
    def __init__(self, host='localhost', port=6060):
        self.host = host
        self.port = port
        self.socket = None
        self.running = False
        self.thread = None
        self.histo = ROOT.TH1F("Histogram 1", "Histogram 1", 32768, 0, 32768)
        self.msg = ROOT.TMessage( )
        self.obj = ROOT.MakeNullPointer(ROOT.TH1F)  
        # Prepare the buffer
        self.buff = { "energy": [], "qshort": [], "qlong": [], "wave1": [], "wave2": [] }
        for key in self.buff.keys():
            for i in range(32):
                self.buff[key].append(ROOT.MakeNullPointer(ROOT.TH1F))
        # Prepare the data
        self.data = { "energy": [], "qshort": [], "qlong": [], "wave1": [], "wave2": [] }
        for key in self.data.keys():
            for i in range(32):
                self.data[key].append(ROOT.TH1F("{} {}".format(key,i), "{} {}".format(key,i), 32768, 0, 32768))      

    def connect(self):
        if DEBUG:
            return
        self.socket = ROOT.TSocket(self.host, self.port)
        if not self.socket.IsValid():
            raise ConnectionError(f"Error connecting to {self.host}:{self.port}")
        return

    def disconnect(self):
        if DEBUG:
            return
        self.socket.Close()
        return

    def send(self, msg):
        if self.socket.Send(msg) <= 0: return False
        return

    def receive(self):
        self.obj = ROOT.MakeNullPointer(ROOT.TH1F)
        nbytes = self.socket.Recv(self.msg)
        if nbytes <= 0:
            return False
        self.obj = self.msg.ReadObject(self.msg.GetClass())
        self.msg.Delete( )
        return self.obj
        
    def start(self, state):
        if DEBUG:
            return
        cmd = "RUSpy"
        for board in state['boards']:
            firmware = 0 if board['dpp'] == "DPP-PHA" else 1
            cmd += f" -d {board['name']} {firmware} {board['chan']}"
        cmd += f" -n {state['run']}"
        os.system(f"{cmd} &")
        
        time.sleep(1)
        
        self.running = True
        self.thread = threading.Thread(target=self.run)
        self.thread.start()

    def run(self):
        while self.running:
            self.collect()
            time.sleep(1)
        return

    def collect(self):
        if DEBUG:
            return
        
        indexes = { "energy": 0, "qshort": 0, "qlong": 0, "wave1": 0, "wave2": 0 }
        self.connect()
        self.send("get")
        try:
            while True:
                obj = self.receive()                
                if( obj == False ): break
                if "Wave1" in obj.GetName():
                    self.buff["wave1"][indexes["wave1"]] = obj
                    indexes["wave1"] += 1
                elif "Wave2" in obj.GetName():
                    self.buff["wave2"][indexes["wave2"]] = obj
                    indexes["wave2"] += 1
                elif "QShort" in obj.GetName():
                    self.buff["qshort"][indexes["qshort"]] = obj
                    indexes["qshort"] += 1
                elif "QLong" in obj.GetName():
                    self.buff["qlong"][indexes["qlong"]] = obj
                    indexes["qlong"] += 1
                elif "Energy" in obj.GetName():
                    self.buff["energy"][indexes["energy"]] = obj
                    indexes["energy"] += 1
                else:
                    obj.Delete()
        except Exception as e:
            print(f"Error receiving histogram: {e}")

        # Fill histograms and delete the buffer
        for key in self.buff.keys():
            for i in range(len(self.buff[key])):
                try:
                    # Set the bins of data to buff
                    for j in range(32768):
                        self.data[key][i].SetBinContent(j, self.buff[key][i].GetBinContent(j))
                    self.buff[key][i].Delete()
                except:
                    pass

        self.disconnect()
        return

    def stop(self):
        self.running = False
        self.thread = None

        try:
            self.connect()
            self.send("stop")
            self.disconnect()
        except:
            os.system("killall RUSpy")
    
    def get_object(self, name, idx):
        try:
            return self.data[name][idx].Clone( )
        except:
            return self.histo

class bu_spy:
    def __init__(self, host='localhost', port=7070):
        self.host = host
        self.port = port
        self.socket = None
        self.running = False
        self.thread = None
        self.histo = ROOT.TH1F("Histogram 2", "Histogram 2", 32768, 0, 32768)
        self.msg = ROOT.TMessage( )
        self.obj = ROOT.MakeNullPointer(ROOT.TH1F)
        # Prepare the data
        self.data = { "energyAnti": [], "qshortAnti": [], "qlongAnti": [], "energySum": [], "qshortSum": [], "qlongSum": [] }
        for key in self.data.keys():
            for i in range(32):
                self.data[key].append(ROOT.TH1F("{} {}".format(key,i), "{} {}".format(key,i), 32768, 0, 32768))
        # Prepare the buffer
        self.buff = { "energyAnti": [], "qshortAnti": [], "qlongAnti": [], "energySum": [], "qshortSum": [], "qlongSum": [] }
        for key in self.buff.keys():
            for i in range(32):
                self.buff[key].append(ROOT.MakeNullPointer(ROOT.TH1F))

    def connect(self):
        self.socket = ROOT.TSocket(self.host, self.port)
        if not self.socket.IsValid():
            raise ConnectionError(f"Error connecting to {self.host}:{self.port}")
        return

    def disconnect(self):
        self.socket.Close()
        return

    def send(self, msg):
        if self.socket.Send(msg) <= 0: return False
        return

    def receive(self):
        self.obj = ROOT.MakeNullPointer(ROOT.TH1F)
        nbytes = self.socket.Recv(self.msg)
        if nbytes <= 0:
            return False
        self.obj = self.msg.ReadObject(self.msg.GetClass())
        self.msg.Delete( )
        return self.obj
        
    def start(self, state):
        cmd = "BUSpy"
        for board in state['boards']:
            firmware = 0 if board['dpp'] == "DPP-PHA" else 1
            cmd += f" -d {board['name']} {firmware} {board['chan']}"
        cmd += f" -n {state['run']}"
        os.system(f"{cmd} &")
        
        time.sleep(1)
        
        self.running = True
        self.thread = threading.Thread(target=self.run)
        self.thread.start()

    def run(self):
        while self.running:
            self.collect()
            time.sleep(1)
        return

    def collect(self):
        indexes = { "energyAnti": 0, "qshortAnti": 0, "qlongAnti": 0, "energySum": 0, "qshortSum": 0, "qlongSum": 0 }
        self.connect()
        self.send("get")
        try:
            while True:
                obj = self.receive()                
                if( obj == False ): break
                if "EnergyAnti" in obj.GetName():
                    self.buff["energyAnti"][indexes["energyAnti"]] = obj
                    indexes["energyAnti"] += 1
                elif "QshortAnti" in obj.GetName():
                    self.buff["qshortAnti"][indexes["qshortAnti"]] = obj
                    indexes["qshortAnti"] += 1
                elif "QlongAnti" in obj.GetName():
                    self.buff["qlongAnti"][indexes["qlongAnti"]] = obj
                    indexes["qlongAnti"] += 1
                elif "EnergySum" in obj.GetName():
                    self.buff["energySum"][indexes["energySum"]] = obj
                    indexes["energySum"] += 1
                elif "QshortSum" in obj.GetName():
                    self.buff["qshortSum"][indexes["qshortSum"]] = obj
                    indexes["qshortSum"] += 1
                elif "QlongSum" in obj.GetName():
                    self.buff["qlongSum"][indexes["qlongSum"]] = obj
                    indexes["qlongSum"] += 1
                else:
                    obj.Delete()
        except Exception as e:
            print(f"Error receiving histogram: {e}")

        # Delete the buffer
        for key in self.buff.keys():
            for i in range(len(self.buff[key])):
                try:
                    for j in range(32768):
                        self.data[key][i].SetBinContent(j, self.buff[key][i].GetBinContent(j))
                    self.buff[key][i].Delete()
                except:
                    pass

        self.disconnect()
        return

    def stop(self):
        self.running = False
        self.thread = None

        try:
            self.connect()
            self.send("stop")
            self.disconnect()
        except:
            os.system("killall BUSpy")
    
    def get_object(self, name, idx):
        try:
            return self.data[name][int(idx)].Clone( )
        except:
            return self.histo