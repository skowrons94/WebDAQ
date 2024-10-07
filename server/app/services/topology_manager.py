from xml.dom import minidom
import time
import os
import socket 
import threading

from app.services.XDAQActor import *

class TopologyManager:
    _topology_filename=""
    _tag_pt="pt::atcp"
    _tag_ru="ReadoutUnit"
    _tag_lf="LocalFilter"
    _tag_bu="rubuilder::bu"
    _tag_mu="rubuilder::merger"
    _tag_gf="GlobalFilter"
    _list_actors = []
    _list_hosts = []
    _ru_actors = []
    _lf_actors = []
    _bu_actors = []
    _mu_actors = []
    _gf_actors = []
    _pt_actors = []
    _debug_on = False
    _actor_type=[]
    _running = False
    _writeGF = False
    _writeMU = False
    _writeBU = False
    _writeLF = False
    _writeRU = False
    def __init__(self,filename):
        self._topology_filename=filename
        self._parser=minidom.parse(self._topology_filename)
        self._number_ru=0
        self._number_lf=0
        self._number_bu=0
        self._number_mu=0
        self._number_gf=0
        self._ru_actors.clear()
        self._lf_actors.clear()
        self._bu_actors.clear()
        self._mu_actors.clear()
        self._gf_actors.clear()
        self._pt_actors.clear()
        self._list_actors.clear()
        self._actor_type.clear()
        self._debug_on = False
        #self._sock = socket.socket()
        #self._sock.connect(('localhost',2003))

    def load_topology(self):
        self.get_number_of_actors()
        self.get_actors()

    def get_number_of_actors(self):
        tagname = self._parser.getElementsByTagName('i2o:target')
        for x in tagname:
            if self._tag_ru in x.attributes['class'].value:
                self._number_ru=self._number_ru+1
            elif self._tag_lf in x.attributes['class'].value:
                self._number_lf=self._number_lf+1
            elif self._tag_bu in x.attributes['class'].value:
                self._number_bu=self._number_bu+1
            elif self._tag_mu in x.attributes['class'].value:
                self._number_mu=self._number_mu+1
            elif self._tag_gf in x.attributes['class'].value:
                self._number_gf=self._number_gf+1

    def get_actors(self):
        tagname = self._parser.getElementsByTagName('xc:Context')
        self._list_hosts = []
        for x in tagname:
            url = x.attributes['url'].value
            subtag = x.getElementsByTagName('xc:Application')
            for y in subtag:
                classname = y.attributes['class'].value
                instance = y.attributes['instance'].value
                identity = y.attributes['id'].value
                if self._tag_pt in classname:
                    self._pt_actors.append(XDAQActor(url,classname,instance,identity))
                if self._tag_ru in classname:
                    self._ru_actors.append(XDAQActor(url,classname,instance,identity))
                elif self._tag_lf in classname:
                    hostname = url[url.find('gal'):url.rfind(":")]
                    alreadyPresent = False
                    for h in self._list_hosts:
                        if h == hostname:
                            alreadyPresent = True
                    if not alreadyPresent:
                        self._list_hosts.append(hostname)
                    self._lf_actors.append(XDAQActor(url,classname,instance,identity))
                elif self._tag_bu in classname:
                    self._bu_actors.append(XDAQActor(url,classname,instance,identity))
                elif self._tag_mu in classname:
                    self._mu_actors.append(XDAQActor(url,classname,instance,identity))
                elif self._tag_gf in classname:
                    self._gf_actors.append(XDAQActor(url,classname,instance,identity))


            # Sorting actors by instance number of commodity 
        self._pt_actors.sort(key=lambda x: x._instance, reverse=False)
        self._ru_actors.sort(key=lambda x: x._instance, reverse=False)
        self._lf_actors.sort(key=lambda x: x._instance, reverse=False)
        self._bu_actors.sort(key=lambda x: x._instance, reverse=False)
        self._mu_actors.sort(key=lambda x: x._instance, reverse=False)
        self._gf_actors.sort(key=lambda x: x._instance, reverse=False)
            # List of all actors which needs to be started and stoped for 
            # each run
        if len(self._ru_actors) > 0:
            self._list_actors.append(self._ru_actors)
            self._actor_type.append("------> RU actors")
        if len(self._lf_actors) > 0:
            self._list_actors.append(self._lf_actors)
            self._actor_type.append("------> LF actors")
        if len(self._bu_actors) > 0:
            self._list_actors.append(self._bu_actors)
            self._actor_type.append("------> BU actors")
        if len(self._mu_actors) > 0:
            self._list_actors.append(self._mu_actors)
            self._actor_type.append("------> MU actors")
        if len(self._gf_actors) > 0:
            self._list_actors.append(self._gf_actors)
            self._actor_type.append("------> GF actors")

        if self._debug_on:
            print("Peer-to-peer transport: ")              
            for act in self._pt_actors:
                act.display()
            
            print("Readout Unit actors: ")
            for act in self._ru_actors:
                act.display()

            print("Local Filter Unit actors: ")
            for act in self._lf_actors:
                act.display()

            print("Builder Unit actors: ")
            for act in self._bu_actors:
                act.display()

            print("Merger Unit actors: ")
            for act in self._mu_actors:
                act.display()

            print("Global Filter Unit actors: ")
            for act in self._gf_actors:
                act.display()
            
            
    def display(self):
        print("=== Topology read in ",               self._topology_filename," ===")
        print("---- Number of readout units: ",      self._number_ru)
        print("---- Number of local filter units: ", self._number_lf)
        print("---- Number of builder units: ",      self._number_bu)
        print("---- Number of merger units: ",       self._number_mu)
        print("---- Number of global filter units: ",self._number_gf)

    def configure_pt(self):
        if self._pt_actors[0].check_status() == 'Ready':
            return True

        print("--- Configuring pt actors:")
        actorOK = nbActors = 0 
        myThreads = []
        nbActors += len(self._pt_actors)
        for act in self._pt_actors:
            myThreads.append(threading.Thread(target=act.configure))
            myThreads[-1].start()
                
        allConfigured = False
        maxIteration = 0
        while not allConfigured:
            time.sleep(0.5)
            for act in self._pt_actors:
                if act.check_status() == 'Ready':
                    allConfigured = True
                    actorOK += 1
                else:
                    allConfigured = False
                    
        if  nbActors == actorOK:
            return True
        else :
            return False

    def enable_pt(self):
        if self._pt_actors[0].check_status() == 'Enabled':
            return True

        print("--- Starting pt actors:")
        actorOK = nbActors = 0 
        myThreads = []
        nbActors += len(self._pt_actors)
        for act in self._pt_actors:
            myThreads.append(threading.Thread(target=act.enable))
            myThreads[-1].start()
                
        allRunning = False
        maxIteration = 0
        while not allRunning:
            time.sleep(0.5)
            for act in self._pt_actors:
                if act.check_status() == 'Enabled':
                    allRunning = True
                    actorOK += 1
                else:
                    allRunning = False
                    
        if  nbActors == actorOK:
            return True
        else :
            return False

    def configure(self):
        if self._ru_actors[0].check_status() == 'Configured':
            return True

        print("--- Configuring actors:")
        actorOK = nbActors = 0 
        for idx,actors in  enumerate(self._list_actors):
            print(self._actor_type[idx])
            myThreads = []
            nbActors += len(actors)
            for act in actors:
                myThreads.append(threading.Thread(target=act.configure))
                myThreads[-1].start()
                
            allConfigured = False
            maxIteration = 0
            while not allConfigured:
                time.sleep(0.5)
                for act in actors:
                    if act.check_status() == 'Configured':
                        allConfigured = True
                        actorOK += 1
                    else:
                        allConfigured = False
                            
        if  nbActors == actorOK:
            return True
        else :
            return False

    def start(self):
        
        if self._ru_actors[0].check_status() == 'Running':
            return True

        print("--- Starting actors:")
        #self._data_manager.createDirectory(time.time(),
        #                                   self.return_run_number())
        actorOK = nbActors = 0 
        for idx in  range(len(self._list_actors)-1,-1,-1):
            print(self._actor_type[idx])
            myThreads = []
            nbActors += len(self._list_actors[idx])
            for act in self._list_actors[idx]:
                myThreads.append(threading.Thread(target=act.enable))
                myThreads[-1].start()
            allStarted = False
            maxIteration = 0
            while not allStarted:
                time.sleep(0.5)
                for act in self._list_actors[idx]:
                    if act.check_status() == 'Running':
                        allStarted = True
                        actorOK += 1
                    else:
                        allStarted = False
        if  nbActors == actorOK:
            return True
        else :
            print(nbActors,actorOK)
            return False
    
    def halt(self):
        if self._ru_actors[0].check_status() == 'Halted':
            return True

        print("--- Halting actors:")
        actorOK = nbActors = 0 
        for idx,actors in  enumerate(self._list_actors):
            print(self._actor_type[idx])
            myThreads = []
            nbActors += len(actors)
            for act in actors:
                myThreads.append(threading.Thread(target=act.halt))
                myThreads[-1].start()
                
            allStopped = False
            maxIteration = 0
            while not allStopped:
                time.sleep(0.5)
                for act in actors:
                    if act.check_status() == 'Halted':
                        allStopped = True
                        actorOK += 1
                    else:
                        allStopped = False

        '''Increment the run to the next '''
        self.set_run_number(self.return_run_number()+1)        
        if  nbActors == actorOK:
            #self._data_manager.moveTkTSpectra(self.get_list_hosts())
            #self._data_manager.convertRawData()
            return True
        else :
            return False
    
    def set_files(self,runNumber):
        enaFiles=[self._writeRU,
                  self._writeLF,
                  self._writeBU,
                  self._writeMU,
                  self._writeGF]
        print("--- Configuring file outputs:")
        for idx,actors in  enumerate(self._list_actors):
            print(self._actor_type[idx])
            for act in actors:
                act.set_run_number(runNumber)
                act.set_file_enable(enaFiles[idx])
    
    def enableGF_file(self,flag):
        self._writeGF = flag
        for act in self._gf_actors:
            act.set_file_enable(self._writeGF)

    def enableMU_file(self,flag):
        self._writeMU = flag
        for act in self._mu_actors:
            act.set_file_enable(self._writeMU)

    def enableBU_file(self,flag):
        self._writeBU = flag
        for act in self._bu_actors:
            act.set_file_enable(self._writeBU)

    def enableLF_file(self,flag):
        self._writeLF = flag
        for act in self._lf_actors:
            act.set_file_enable(self._writeLF)
    
    def enableRU_file(self,flag):
        self._writeRU = flag
        for act in self._ru_actors:
            act.set_file_enable(self._writeRU)
    
    def is_ru_file_ena(self):
        return self._writeRU

    def is_lf_file_ena(self):
        return self._writeLF

    def is_bu_file_ena(self):
        return self._writeBU

    def is_mu_file_ena(self):
        return self._writeMU

    def is_gf_file_ena(self):
        return self._writeGF

    def set_run_number(self,runNumber):
        for idx,actors in  enumerate(self._list_actors):
            for act in actors:
                act.set_run_number(runNumber)

    def return_run_number(self):
        return self._gf_actors[0].get_run_number()
        
    def how_many_ru(self):
        return self._number_ru

    def how_many_lf(self):
        return self._number_lf

    def how_many_bu(self):
        return self._number_bu

    def how_many_mu(self):
        return self._number_mu

    def how_many_gf(self):
        return self._number_gf

    def get_all_actors(self):
        return self._list_actors

    def get_ru_actors(self):
        return self._ru_actors

    def get_lf_actors(self):
        return self._lf_actors

    def get_bu_actors(self):
        return self._bu_actors

    def get_mu_actors(self):
        return self._mu_actors

    def get_gf_actors(self):
        return self._gf_actors

    def get_topology_filename(self):
        return self._topology_filename
    
    def get_daq_status(self):
        daq_status = "Unknown"
        for act in self._pt_actors:
            if "Halted" in act.check_status():
                daq_status = "Unknown"
            elif "Enabled" in act.check_status():
                daq_status = "Initialized"
                for actDaq in self._ru_actors:
                    if "Configured" in actDaq.check_status():
                        daq_status = "Configured"
                    elif "Running" in actDaq.check_status():
                        daq_status = "Running"
                    elif "Halted" in actDaq.check_status():
                        daq_status = "Initialized"
        return daq_status
    
    def start_monitoring_thread(self):
        self._running=True
        self._thread_monitoring = threading.Thread(target=self.monitor_actors)
        self._thread_monitoring.start()

    def stop_monitoring_thread(self):
        self._running=False
        self._thread_monitoring.join(timeout=5.)

    def get_list_hosts(self):
        return self._list_hosts
                    
    def list_all_actors_nice(self):
        message=""
        for idx,actors in  enumerate(self._list_actors) :
            for act in actors:
                host = str(act.return_hostname()[0:6])
                message += '{:s} {:s} {:s} {:d}\n'.format(host,
                                                          act.return_actor_info_url(),
                                                          act.return_classname_nice(),
                                                          act.return_instance())
        return str(message)
    
    def monitor_actors(self):
        while self._ru_actors[0].check_status() == "Running":
            localtime=int(time.time())
            message = ""
            for idx,actors in  enumerate(self._list_actors) :
                for act in actors:
                    host = str(act.return_hostname())
                    host = host[0:host.find(".lnl")]
                    host=host.replace("-","_")
                    classname = str(act.return_classname_nice())
                    classname=classname.replace(" ","_")
                    message += 'xdaq.{:s}.{:s}.{:d}.outputBufferRate {:s} {:d}\n'.\
                        format(classname,host,act.return_instance(),
                               act.get_output_bandwith(),localtime)
                    message += 'xdaq.{:s}.{:s}.{:d}.inputBufferRate {:s} {:d}\n'.\
                        format(classname,host,act.return_instance(),
                               act.get_input_bandwith(),localtime)
            #self._sock.sendall(message.encode())
            time.sleep(0.5)
            
    def set_coincidence_window(self,window):
        '''For the moment we set the same time window for all the builders/merger'''
        for actors in self._bu_actors:
            actors.set_coinc_window(window)
        for actors in self._mu_actors:
            actors.set_coinc_window(window)
            print("Merger coincidence window",actors.get_coinc_window())

    def return_coincidence_window(self):
        return self._mu_actors[0].get_coinc_window()

    def return_filter_conf(self,instance):
        if instance >=  len(self._lf_actors):
            return 'None'
        else:
            return self._lf_actors[instance].get_configuration_file()
            
