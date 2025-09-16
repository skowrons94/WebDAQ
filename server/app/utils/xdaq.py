import os
import time
import pycurl
import socket
import docker
import threading

import xml.etree.ElementTree as ET

from docker.types import IPAMConfig, IPAMPool
from xml.dom import minidom
from io import StringIO, BytesIO

class xdaq_messenger:
    _message=""
    _hostname=""
    _hostport=""
    _instance=""
    _classname=""
    
    def __init__(self, hostname, hostport, instance, classname):
        self._message="toto"
        self._hostname = hostname
        self._hostport = hostport
        self._instance = str(instance)
        self._classname = classname

    def create_action_message(self,action):
        message = "<SOAP-ENV:Envelope SOAP-ENV:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\" xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:SOAP-ENC=\"http://schemas.xmlsoap.org/soap/encoding/\"><SOAP-ENV:Header></SOAP-ENV:Header><SOAP-ENV:Body><xdaq:"+action+" xmlns:xdaq=\"urn:xdaq-soap:3.0\"/></SOAP-ENV:Body></SOAP-ENV:Envelope>" 
        return message

    def create_info_message(self,parName, parType):
        message = "<SOAP-ENV:Envelope SOAP-ENV:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\" xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:SOAP-ENC=\"http://schemas.xmlsoap.org/soap/encoding/\"><SOAP-ENV:Header></SOAP-ENV:Header><SOAP-ENV:Body><xdaq:ParameterGet xmlns:xdaq=\"urn:xdaq-soap:3.0\"><p:properties xmlns:p=\"urn:xdaq-application:"+self._classname+"\" xsi:type=\"soapenc:Struct\"><p:"+parName+" xsi:type=\""+parType+"\"/></p:properties></xdaq:ParameterGet></SOAP-ENV:Body></SOAP-ENV:Envelope>";
        return message

    def create_parameter_message(self,parName,parType,parValue):
        message = "<SOAP-ENV:Envelope SOAP-ENV:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\" xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:SOAP-ENC=\"http://schemas.xmlsoap.org/soap/encoding/\"><SOAP-ENV:Header></SOAP-ENV:Header><SOAP-ENV:Body><xdaq:ParameterSet xmlns:xdaq=\"urn:xdaq-soap:3.0\"><p:properties xmlns:p=\"urn:xdaq-application:"+self._classname+"\" xsi:type=\"soapenc:Struct\"><p:"+parName+" xsi:type=\""+parType+"\">"+parValue+"</p:"+parName+"></p:properties></xdaq:ParameterSet></SOAP-ENV:Body></SOAP-ENV:Envelope>"
        return message

    def send_message(self,message):
        hostURL="http://"+self._hostname+":"+self._hostport
    
        actionClient="SOAPAction: urn:xdaq-application:class="+self._classname+",instance="+self._instance
        header = [actionClient,"Content-Type: text/xml","Content-Description: SOAP Message"]
        answer = BytesIO()
        c = pycurl.Curl()
        c.setopt(pycurl.URL, hostURL)
        c.setopt(pycurl.HTTPHEADER, header)
        c.setopt(pycurl.POST,0)
        c.setopt(pycurl.POSTFIELDS, str(message))
        c.setopt(pycurl.WRITEFUNCTION, answer.write)
        c.setopt(pycurl.WRITEDATA,answer)
#        c.setopt(pycurl.VERBOSE,2)
        c.perform()
        response=answer.getvalue().decode('UTF-8')
        c.close()
        return response
        
class filters_control:
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

class xdaq_actor:
    _url = ""
    _hostname = ""
    _hostport = ""
    _instance = 0
    _classname = ""
    _enable_file = False
    _id = 0
    def __init__(self, url, classname, instance, identity):
        self._url = url
        self._instance = int(instance)
        self._classname = classname
        self._enable_file = False
        self._hostname=socket.gethostname()
        self._hostport=url[url.rfind(':')+1:]
        self._messenger=xdaq_messenger(self._hostname,self._hostport,self._instance,self._classname)
        self._id = identity
        
    def set_url(self, url):
        self._url = url
        
    def set_hostname(self, hostname):
        self._hostname = hostname

    def set_hostport(self, hostport):
        self._hostport = hostport

    def set_instance(self, instance):
        self._instance = instance

    def set_class(self, classname):
        self._class = classname

    def set_enablefile(self, fileenable):
        self._enable_file = fileenable

    def return_hostname(self):
        return self._hostname
    
    def return_hostport(self):
        return self._hostport
    
    def return_classname(self):
        return self._classname
    
    def return_instance(self):
        return self._instance

    def return_identity(self):
        return self._identity

    def return_classname_nice(self):
        name = ""
        if "::ru::" in self._classname:
            name = "Readout_Unit"
        elif "Local" in self._classname:
            name = "Local_Filter"
        elif "::bu::" in self._classname:
            name = "Builder_Unit"
        elif "::merger::" in self._classname:
            name = "Merger_Unit"
        elif "Global" in self._classname:
            name ="Global_Filter"
        else:
            name =self._classname
        
        return name

    def return_url(self):
        return self._url

    def return_actor_info_url(self):
        return self._url+'/urn:xdaq-application:lid='+str(self._id)

    def display(self):
        print("----> Actor running on ", self._url,
              " class = ", self._classname,
              " instance = ", self._instance,
              " host = ", self._hostname,
              " port = ", self._hostport)
        
    def check_status(self):
        message = self._messenger.create_info_message("stateName","xsd:string")
        answer = self._messenger.send_message(message)
        positionEnd = answer.find("</p:stateName")
        positionBeg = answer.rfind(">",positionEnd-20,positionEnd)
        status = answer[positionBeg+1:positionEnd]
        return status              

    def get_output_bandwith(self):
        message = self._messenger.create_info_message("outputBandw","xsd:string")
        answer = self._messenger.send_message(message)
        positionEnd = answer.find("</p:outputBandw")
        positionBeg = answer.rfind(">",positionEnd-20,positionEnd)
        return answer[positionBeg+1:positionEnd]
    
    def get_file_bandwith(self):
        message = self._messenger.create_info_message("fileBandw","xsd:string")
        answer = self._messenger.send_message(message)
        positionEnd = answer.find("</p:fileBandw")
        positionBeg = answer.rfind(">",positionEnd-20,positionEnd)
        return answer[positionBeg+1:positionEnd]

    def get_input_bandwith(self):
        message = self._messenger.create_info_message("inputBandw","xsd:string")
        answer = self._messenger.send_message(message)
        positionEnd = answer.find("</p:inputBandw")
        positionBeg = answer.rfind(">",positionEnd-20,positionEnd)
        return answer[positionBeg+1:positionEnd]
        
    def configure(self):
        message = self._messenger.create_action_message("Configure")
        self._messenger.send_message(message)

    def enable(self):
        message = self._messenger.create_action_message("Enable")
        self._messenger.send_message(message)

    def halt(self):
        message = self._messenger.create_action_message("Halt")
        self._messenger.send_message(message)
    
    def set_run_number(self,runnumber):
        message = self._messenger.create_parameter_message("runNumber",
                                                           "xsd:unsignedInt",
                                                           str(runnumber))
        self._messenger.send_message(message)

    def set_file_path(self,filepath):
        message = self._messenger.create_parameter_message("outputFilepath",
                                                           "xsd:string",
                                                           filepath)
        self._messenger.send_message(message)

    def set_file_size_limit(self,filelimit):
        message = self._messenger.create_parameter_message("outputFileSizeLimit_MB",
                                                           "xsd:unsignedLong",
                                                           str(filelimit))
        self._messenger.send_message(message)

    def get_run_number(self):
        message = self._messenger.create_info_message("runNumber","xsd:unsignedInt")
        answer = self._messenger.send_message(message)
        positionEnd = answer.find("</p:runNumber")
        positionBeg = answer.rfind(">",positionEnd-20,positionEnd)
        return int(answer[positionBeg+1:positionEnd])

    def set_coinc_window(self,window):
        message = self._messenger.create_parameter_message("merge_window",
                                                           "xsd:unsignedInt",
                                                           str(window))
        self._messenger.send_message(message)

    def set_multiplicity(self,multiplicity):
        message = self._messenger.create_parameter_message("multiplicity",
                                                           "xsd:unsignedInt",
                                                           str(multiplicity))
        self._messenger.send_message(message)

    def get_coinc_window(self):
        message = self._messenger.create_info_message("merge_window","xsd:unsignedInt")
        answer = self._messenger.send_message(message)
        positionEnd = answer.find("</p:merge_window")
        positionBeg = answer.rfind(">",positionEnd-20,positionEnd)
        return int(answer[positionBeg+1:positionEnd])

    def set_cycle_counter(self,n):
        message = self._messenger.create_parameter_message("cycleCounter",
                                                           "xsd:unsignedInt",
                                                           str(n))
        self._messenger.send_message(message)

    def set_file_enable(self,file_enable):
        message = ""
        if file_enable:
            print("--------> Enabling file")
            message=self._messenger.create_parameter_message("writeDataFile",
                                                             "xsd:boolean",
                                                             "true")
        else:
            print("--------> Disabling file")
            message=self._messenger.create_parameter_message("writeDataFile",
                                                             "xsd:boolean",
                                                             "false")
        self._messenger.send_message(message)
        

    def get_configuration_file(self):
        message = self._messenger.create_info_message("configFilepath","xsd:string")
        answer = self._messenger.send_message(message)
        positionEnd = answer.find("</p:configFilepath")
        positionBeg = answer.rfind(">",positionEnd-60,positionEnd)
        return answer[positionBeg+1:positionEnd]

    
class topology:
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
                    self._pt_actors.append(xdaq_actor(url,classname,instance,identity))
                if self._tag_ru in classname:
                    self._ru_actors.append(xdaq_actor(url,classname,instance,identity))
                elif self._tag_lf in classname:
                    hostname = url[url.find('gal'):url.rfind(":")]
                    alreadyPresent = False
                    for h in self._list_hosts:
                        if h == hostname:
                            alreadyPresent = True
                    if not alreadyPresent:
                        self._list_hosts.append(hostname)
                    self._lf_actors.append(xdaq_actor(url,classname,instance,identity))
                elif self._tag_bu in classname:
                    self._bu_actors.append(xdaq_actor(url,classname,instance,identity))
                elif self._tag_mu in classname:
                    self._mu_actors.append(xdaq_actor(url,classname,instance,identity))
                elif self._tag_gf in classname:
                    self._gf_actors.append(xdaq_actor(url,classname,instance,identity))


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
                    print("Configure", act.check_status(), act.display())
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
        #self._data_manager.createDirectory(time.time(),self.return_run_number())
        actorOK = nbActors = 0 
        for idx in range(len(self._list_actors)-1,-1,-1):
            print(self._actor_type[idx], idx)
            myThreads = []
            nbActors += len(self._list_actors[idx])
            for act in self._list_actors[idx]:
                myThreads.append(threading.Thread(target=act.enable))
                myThreads[-1].start()
        
        allStarted = False
        maxIteration = 0
        while not allStarted:
            time.sleep(0.5)
            for idx in range(len(self._list_actors)):
                for act in self._list_actors[idx]:
                    print(act.check_status(), act.display())
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
        
    def write_ruconf(self, state):
        if not os.path.exists('conf'): 
            os.makedirs('conf')
        with open('conf/RUCaen.conf', 'w') as f:
            f.write(f"NumberOfBoards {len(state['boards'])}\n\n")
            for board in state['boards']:
                conf = "/home/xdaq/project/conf/{}_{}.json".format(board['name'], board['id'])
                if board['link_type'] == "USB": link_type = 0
                elif board['link_type'] == "Optical": link_type = 1
                elif board['link_type'] == "A4818": link_type = 5
                f.write(f"Board {board['name']} {board['id']} {board['vme']} {link_type} {board['link_num']} {board['id']}\n")
                f.write(f"BoardConf {board['id']} {conf}\n")

    def write_lfconf(self, state):
        if not os.path.exists('conf'):
            os.makedirs('conf')
        with open('conf/LocalFilter.conf', 'w') as f:
            f.write(f"SaveDataDir .\n\n")
            for board in state['boards']:
                f.write(f"SpecPrefix {board['id']} {board['name']}\n")
                if board["dpp"] == "DPP-PHA": dpp = "DPP_PHA"
                elif board["dpp"] == "DPP-PSD": dpp = "DPP_PSD"
                name = board['name']
                if( "DT5781" in name or "V1724" in name ):
                    timestamp = 10
                    sampling = 10
                elif( "V1730" in name ):
                    timestamp = 2
                    sampling = 2
                elif( "V1725" in name ):
                    timestamp = 4
                    sampling = 4
                else:
                    timestamp = 1
                    sampling = 1
                f.write(f"Board {board['id']} {board['name']} {dpp} {board['chan']} 0 {timestamp} {sampling}\n")
            f.write("GraphiteServer graphite 2003\n")

    def write_buconf(self, state):
        if not os.path.exists('conf'):
            os.makedirs('conf')
        with open('conf/Builder.conf', 'w') as f:
            f.write("0111_1110_0000_0000")
    
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
        return self._ru_actors[0].get_run_number()
        
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
            print("Builder coincidence window",actors.get_coinc_window())
        for actors in self._mu_actors:
            actors.set_coinc_window(window)
            print("Merger coincidence window",actors.get_coinc_window())

    def set_multiplicity(self,multiplicity):
        for actors in self._bu_actors:
            actors.set_multiplicity(multiplicity)

    def set_file_paths(self,filepath,idx=0):
        for actors in self._ru_actors:
            if idx==0:
                actors.set_file_path(filepath+"/ru")
            else:
                actors.set_file_path(filepath+"/ru"+str(idx))
        for actors in self._lf_actors:
            if idx==0:
                actors.set_file_path(filepath+"/lf")
            else:
                actors.set_file_path(filepath+"/lf"+str(idx))   
        for actors in self._bu_actors:
            if idx==0:
                actors.set_file_path(filepath+"/bu")
            else:
                actors.set_file_path(filepath+"/bu"+str(idx))
        for actors in self._mu_actors:
            actors.set_file_path(filepath)
        for actors in self._gf_actors:
            actors.set_file_path(filepath)

    def set_enable_files(self,flag):
        self.enableRU_file(flag)
        #self.enableLF_file(flag)
        #self.enableBU_file(flag)
        #self.enableMU_file(flag)
        #self.enableGF_file(flag)
        self.enableLF_file(False)
        self.enableBU_file(False)
        self.enableMU_file(False)
        self.enableGF_file(False)

    def set_cycle_counter(self,n):
        for actors in self._ru_actors:
            actors.set_cycle_counter(n)
        for actors in self._lf_actors:
            actors.set_cycle_counter(n)
        for actors in self._bu_actors:
            actors.set_cycle_counter(n)

    def set_file_size_limit(self,filelimit):
        for actors in self._ru_actors:
            actors.set_file_size_limit(filelimit)
        for actors in self._lf_actors:
            actors.set_file_size_limit(filelimit)
        for actors in self._bu_actors:
            actors.set_file_size_limit(filelimit)
        for actors in self._mu_actors:
            actors.set_file_size_limit(filelimit)
        for actors in self._gf_actors:
            actors.set_file_size_limit(filelimit)

    def return_coincidence_window(self):
        return self._mu_actors[0].get_coinc_window()

    def return_filter_conf(self,instance):
        if instance >=  len(self._lf_actors):
            return 'None'
        else:
            return self._lf_actors[instance].get_configuration_file()
            
class container:

    def __init__(self, directory):
        self.client = docker.from_env()
        self.ipam_pool = IPAMPool(
            subnet='192.168.100.0/24',
            gateway='192.168.100.1'
        )
        self.ipam_config = IPAMConfig(pool_configs=[self.ipam_pool])
        self.directory = directory

    def initialize(self):

        if not any(n.name == "xdaq-net" for n in self.client.networks.list()): self.client.networks.create("xdaq-net", ipam=self.ipam_config)

        self.client.containers.run( "skowrons/xdaq:latest", "sleep infinity", 
                                    hostname="xdaq", 
                                    name="xdaq",
                                    network='xdaq-net',
                                    ports={'50000': 50000, '10000': 10000},
                                    volumes={self.directory: {'bind': '/home/xdaq/project', 'mode': 'rw'},
                                             '/dev':         {'bind': '/dev',               'mode': 'rw'}, 
                                             '/lib/modules': {'bind': '/lib/modules',       'mode': 'rw'}},
                                    environment=["TZ=Europe/Rome"],
                                    detach=True, 
                                    remove=True,
                                    privileged=True )
            
        cmd = "/opt/xdaq/bin/xdaq.exe -p 50000 -c /home/xdaq/project/conf/topology.xml"
        self.client.containers.get("xdaq").exec_run(cmd, detach=True, tty=True, stdin=True, stdout=True, stderr=True)

        time.sleep(1)

    def reset( self ):

        # If container xdaq exists, remove it
        try: self.client.containers.get("xdaq").remove(force=True)
        except docker.errors.NotFound: pass

        # Run container xdaq
        self.client.containers.run( "skowrons/xdaq:latest", "sleep infinity", 
                                    hostname="xdaq", 
                                    name="xdaq",
                                    network='xdaq-net',
                                    ports={'50000': 50000, '10000': 10000},
                                    volumes={self.directory: {'bind': '/home/xdaq/project', 'mode': 'rw'},
                                             '/dev':         {'bind': '/dev',               'mode': 'rw'}, 
                                             '/lib/modules': {'bind': '/lib/modules',       'mode': 'rw'}},
                                    environment=["TZ=Europe/Rome"],
                                    detach=True, 
                                    remove=True, 
                                    privileged=True )

        # Start ReadoutUnit in the container
        cmd = "/opt/xdaq/bin/xdaq.exe -p 50000 -c /home/xdaq/project/conf/topology.xml"
        self.client.containers.get("xdaq").exec_run(cmd, detach=True, tty=True, stdin=True, stdout=True, stderr=True)

        #time.sleep(1)

        # Start LocalFilter in the container
        #cmd = "/opt/xdaq/bin/xdaq.exe -p 51000 -c /home/xdaq/project/conf/topology.xml"
        #self.client.containers.get("xdaq").exec_run(cmd, detach=True, tty=True, stdin=True, stdout=True, stderr=True)

        #time.sleep(1)

        # Start BuilderUnit in the container
        #cmd = "/opt/xdaq/bin/xdaq.exe -p 52000 -c /home/xdaq/project/conf/topology.xml"
        #self.client.containers.get("xdaq").exec_run(cmd, detach=True, tty=True, stdin=True, stdout=True, stderr=True)

        time.sleep(1)

    # Function to kill xdaq processes in the container, restart it, enable the actors and start the run
    def restart( self ):
        cmd = "killall xdaq.exe"
        self.client.containers.get("xdaq").exec_run(cmd, detach=True, tty=True, stdin=True, stdout=True, stderr=True)

        time.sleep(1)

        cmd = "/opt/xdaq/bin/xdaq.exe -p 50000 -c /home/xdaq/project/conf/topology.xml"
        self.client.containers.get("xdaq").exec_run(cmd, detach=True, tty=True, stdin=True, stdout=True, stderr=True)

        #time.sleep(1)

        #cmd = "/opt/xdaq/bin/xdaq.exe -p 51000 -c /home/xdaq/project/conf/topology.xml"
        #self.client.containers.get("xdaq").exec_run(cmd, detach=True, tty=True, stdin=True, stdout=True, stderr=True)

        #time.sleep(1)

        #cmd = "/opt/xdaq/bin/xdaq.exe -p 52000 -c /home/xdaq/project/conf/topology.xml"
        #self.client.containers.get("xdaq").exec_run(cmd, detach=True, tty=True, stdin=True, stdout=True, stderr=True)

        time.sleep(1)        

    def stop( self ):
        # If container xdaq exists, remove it
        try: self.client.containers.get("xdaq").remove(force=True)
        except docker.errors.NotFound: pass
