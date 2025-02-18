import time
import numpy
import json

from ctypes import *
from typing import Dict

libCAENDigitizer = CDLL('/usr/lib/libCAENDigitizer.so')

def check_error_code(code):
	"""Check if the code returned by a function of the libCAENDigitizer
	library is an error or not. If it is not an error, nothing is done,
	if it is an error, a `RuntimeError` is raised with the error code.
	"""
	if code != 0:
		raise RuntimeError(f'CAENDigitizer has returned error code {code}.')

def struct2dict(struct):
	return dict((field, getattr(struct, field)) for field, _ in struct._fields_)

class BoardInfo(Structure):
	_fields_ = [
		("ModelName", c_char*12),
		("Model", c_uint32),
		("Channels", c_uint32),
		("FormFactor", c_uint32),
		("FamilyCode", c_uint32),
		("ROC_FirmwareRel", c_char*20),
		("AMC_FirmwareRel", c_char*40),
		("SerialNumber", c_uint32),
		("MezzanineSerNum", (c_char*8)*4),
		("PCB_Revision", c_uint32),
		("ADC_NBits", c_uint32),
		("SAMCorrectionDataLoaded", c_uint32),
		("CommHandle", c_int),
		("VMEHandle", c_int),
		("License", c_char*999),
	]

class digitizer:
    
    def __init__(self, LinkType:int, LinkNum:int, BoardId:int, VmeAddress:int):

        self._connected = False
        self._LinkNum = LinkNum
        self._LinkType = LinkType
        self._BoardId = BoardId
        self._VmeAddress = VmeAddress   
        self.__handle = c_int()

    def open(self):
        if self._connected == False:
            code = libCAENDigitizer.CAEN_DGTZ_OpenDigitizer(c_long(self._LinkType), c_int(self._LinkNum), c_int(self._BoardId), c_uint32(self._VmeAddress), byref(self.__handle))
            check_error_code(code)
            self._connected = True
    
    def close(self):
        if self._connected == True:
            code = libCAENDigitizer.CAEN_DGTZ_CloseDigitizer(self.__handle)
            check_error_code(code)
            self._connected = False

    def get_connected(self):
        if self._connected == True: return True
        else: return False
    
    def get_handle(self):
        return self.__handle

    def get_info(self)->dict:
        info = BoardInfo()
        code = libCAENDigitizer.CAEN_DGTZ_GetInfo(self.get_handle(), byref(info))
        check_error_code(code)
        info = struct2dict(info)
        info["ModelName"] = info["ModelName"].decode('utf-8')
        info["ROC_FirmwareRel"] = info["ROC_FirmwareRel"].decode('utf-8')
        return info

    def write_register(self, address, data):
        code = libCAENDigitizer.CAEN_DGTZ_WriteRegister(self.get_handle(), c_uint32(address), c_uint32(data))
        check_error_code(code)

    def read_register(self, address):
        data = c_uint32()
        code = libCAENDigitizer.CAEN_DGTZ_ReadRegister(self.get_handle(), c_uint32(address), byref(data),)
        check_error_code(code)
        return data.value

    def set_board_id(self):
        reg = self.write_register(0xEF08, self._BoardId)

    def read_pha(self, file_name: str) -> None:
        
        map_register: Dict[int, str] = {
            0x1034: "Number of Events per Aggregate",
            0x1038: "Pre Trigger",
            0x1044: "Shaped Trigger Delay",
            0x1054: "RC-CR2 Smoothing Factor",
            0x1058: "Input Rise Time",
            0x105C: "Trapezoid Rise Time",
            0x1060: "Trapezoid Flat Top",
            0x1064: "Peaking Time",
            0x1068: "Decay Time",
            0x106C: "Trigger Threshold",
            0x1074: "Trigger Hold-Off Width",
            0x1078: "Peak Hold-Off",
            0x107C: "Baseline Hold-Off",
            0x1080: "DPP Algorithm Control",
            0x1084: "Shaped Trigger Width",
            0x1098: "DC Offset",
            0x10A0: "DPP Algorithm Control 2",
            0x10B8: "Trapezoid Baseline Offset",
            0x10C4: "Fine Gain",
            0x10D4: "Veto Width",
            0x8000: "Board Configuration",
            0x800C: "Aggregate Configuration",
            0x8020: "Record Length",
            0x8100: "Acquistion Control",
            0x810C: "Global Trigger Mask",
            0x8120: "Channel Enable Mask",
            0xEF08: "Board ID",
            0xEF1C: "Aggregate Number per BLT"
        }

        reg_list = {}
        dgt_list = {}
        
        # Get board information
        info = self.get_info()

        # Populate board info
        dgt_list["BoardName"] = str(info["ModelName"])
        dgt_list["Model"] = str(info["Model"])
        dgt_list["NbChannels"] = str(info["Channels"])
        dgt_list["SerialNumber"] = str(info["SerialNumber"])
        dgt_list["LinkNb"] = str(self._LinkNum)
        dgt_list["BoardNb"] = str(self._BoardId)
        dgt_list["ConnectionType"] = str(self._LinkType)
        dgt_list["Firmware"] = str(info["ROC_FirmwareRel"])

        dgtz = {"dgtzs": dgt_list}

        for reg_address, reg_name in map_register.items():
            reg_value = self.read_register(reg_address)
            reg_addr_str = f"0x{reg_address:04x}"
            reg_val_str = f"0x{reg_value:x}"

            reg_key = f"reg_{reg_address:04x}"
            reg_list[reg_key] = {
                "name": reg_name,
                "channel": 0,
                "address": reg_addr_str,
                "value": reg_val_str
            }

            if reg_address > 0x2000: continue
            else:
                
                max_offset = 0x100 * info["Channels"]
                for offset in range(0x100, max_offset, 0x100):
                    current_addr = reg_address + offset
                    ch_value = self.read_register(current_addr)
                    ch_addr_str = f"0x{current_addr:04x}"
                    ch_val_str = f"0x{ch_value:x}"

                    ch_key = f"reg_{current_addr:04x}"
                    reg_list[ch_key] = {
                        "name": reg_name,
                        "channel": offset >> 8,
                        "address": ch_addr_str,
                        "value": ch_val_str
                    }

        dgtz["registers"] = reg_list

        with open(file_name, 'w') as f:
            json.dump(dgtz, f, indent=2, ensure_ascii=False)

    def read_psd(self, file_name: str) -> None:
        
        map_register: Dict[int, str] = {
            0x1034: "Number of Events per Aggregate",
            0x1038: "Pre Trigger",
            0x1044: "Shaped Trigger Delay",
            0x1054: "RC-CR2 Smoothing Factor",
            0x1058: "Input Rise Time",
            0x105C: "Trapezoid Rise Time",
            0x1060: "Trapezoid Flat Top",
            0x1064: "Peaking Time",
            0x1068: "Decay Time",
            0x106C: "Trigger Threshold",
            0x1074: "Trigger Hold-Off Width",
            0x1078: "Peak Hold-Off",
            0x107C: "Baseline Hold-Off",
            0x1080: "DPP Algorithm Control",
            0x1084: "Shaped Trigger Width",
            0x1098: "DC Offset",
            0x10A0: "DPP Algorithm Control 2",
            0x10B8: "Trapezoid Baseline Offset",
            0x10C4: "Fine Gain",
            0x10D4: "Veto Width",
            0x8000: "Board Configuration",
            0x800C: "Aggregate Configuration",
            0x8020: "Record Length",
            0x8100: "Acquistion Control",
            0x810C: "Global Trigger Mask",
            0x8120: "Channel Enable Mask",
            0xEF08: "Board ID",
            0xEF1C: "Aggregate Number per BLT"
        }

        reg_list = {}
        dgt_list = {}
        
        # Get board information
        info = self.get_info()

        # Populate board info
        dgt_list["BoardName"] = str(info["ModelName"])
        dgt_list["Model"] = str(info["Model"])
        dgt_list["NbChannels"] = str(info["Channels"])
        dgt_list["SerialNumber"] = str(info["SerialNumber"])
        dgt_list["LinkNb"] = str(self._LinkNum)
        dgt_list["BoardNb"] = str(self._BoardId)
        dgt_list["ConnectionType"] = str(self._LinkType)
        dgt_list["Firmware"] = str(info["ROC_FirmwareRel"])

        dgtz = {"dgtzs": dgt_list}

        for reg_address, reg_name in map_register.items():
            reg_value = self.read_register(reg_address)
            reg_addr_str = f"0x{reg_address:04x}"
            reg_val_str = f"0x{reg_value:x}"

            reg_key = f"reg_{reg_address:04x}"
            reg_list[reg_key] = {
                "name": reg_name,
                "channel": 0,
                "address": reg_addr_str,
                "value": reg_val_str
            }

            if reg_address > 0x2000: continue
            else:
                
                max_offset = 0x100 * info["Channels"]
                for offset in range(0x100, max_offset, 0x100):
                    current_addr = reg_address + offset
                    ch_value = self.read_register(current_addr)
                    ch_addr_str = f"0x{current_addr:04x}"
                    ch_val_str = f"0x{ch_value:x}"

                    ch_key = f"reg_{current_addr:04x}"
                    reg_list[ch_key] = {
                        "name": reg_name,
                        "channel": offset >> 8,
                        "address": ch_addr_str,
                        "value": ch_val_str
                    }

        dgtz["registers"] = reg_list

        with open(file_name, 'w') as f:
            json.dump(dgtz, f, indent=2, ensure_ascii=False)