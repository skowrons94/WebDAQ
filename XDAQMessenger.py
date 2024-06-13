import zeep
import pycurl 
from io import StringIO, BytesIO

class XDAQMessenger:
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
        
