from app.services.XDAQMessenger  import *
from app.services.FiltersControl import *
import xml.etree.ElementTree as ET
import time
import socket

class XDAQActor:
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
        self._messenger=XDAQMessenger(self._hostname,self._hostport,self._instance,self._classname)
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
        if "Readout" in self._classname:
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

    def get_coinc_window(self):
        message = self._messenger.create_info_message("merge_window","xsd:unsignedInt")
        answer = self._messenger.send_message(message)
        positionEnd = answer.find("</p:merge_window")
        positionBeg = answer.rfind(">",positionEnd-20,positionEnd)
        return int(answer[positionBeg+1:positionEnd])

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
