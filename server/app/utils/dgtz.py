"""
CAEN Digitizer Utility Module

This module provides a Python interface for CAEN digitizer boards using the
CAENDigitizer library. It handles board connection, configuration, and register
management for both DPP-PHA and DPP-PSD firmware modes.

Key Features:
- Board connection and information retrieval
- Register read/write operations
- DPP-PHA and DPP-PSD configuration file generation
- Comprehensive error handling and logging
- Test mode support for development without hardware

Author: Scientific DAQ Team
Purpose: CAEN digitizer interface for LUNA experiment
"""

import os
import json
import logging
from ctypes import *
from typing import Dict, Optional

# Configure logging
logger = logging.getLogger(__name__)

# Check if running in test mode (no hardware)
TEST_FLAG = os.getenv('TEST_FLAG', False)

# Load CAEN digitizer library if not in test mode
if not TEST_FLAG:
    try:
        libCAENDigitizer = CDLL('/usr/lib/libCAENDigitizer.so')
        logger.info("CAEN Digitizer library loaded successfully")
    except OSError as e:
        logger.error(f"Failed to load CAEN Digitizer library: {e}")
        TEST_FLAG = True


def check_error_code(code: int) -> None:
    """
    Check if the code returned by a CAEN Digitizer library function indicates an error.
    
    Args:
        code: Return code from CAEN library function
        
    Raises:
        RuntimeError: If the error code indicates a failure
    """
    if code != 0:
        error_msg = f'CAENDigitizer returned error code {code}'
        logger.error(error_msg)
        raise RuntimeError(error_msg)


def struct2dict(struct) -> Dict:
    """
    Convert a ctypes Structure to a Python dictionary.
    
    Args:
        struct: ctypes Structure object
        
    Returns:
        dict: Dictionary representation of the structure
    """
    return dict((field, getattr(struct, field)) for field, _ in struct._fields_)


class BoardInfo(Structure):
    """
    ctypes Structure representing CAEN digitizer board information.
    Maps directly to the CAEN_DGTZ_BoardInfo_t structure.
    """
    _fields_ = [
        ("ModelName", c_char * 12),        # Board model name
        ("Model", c_uint32),               # Board model number
        ("Channels", c_uint32),            # Number of channels
        ("FormFactor", c_uint32),          # Form factor (desktop/NIM/VME)
        ("FamilyCode", c_uint32),          # Digitizer family code
        ("ROC_FirmwareRel", c_char * 20),  # ROC firmware release
        ("AMC_FirmwareRel", c_char * 40),  # AMC firmware release
        ("SerialNumber", c_uint32),        # Board serial number
        ("MezzanineSerNum", (c_char * 8) * 4),  # Mezzanine serial numbers
        ("PCB_Revision", c_uint32),        # PCB revision
        ("ADC_NBits", c_uint32),           # ADC resolution in bits
        ("SAMCorrectionDataLoaded", c_uint32),  # SAM correction status
        ("CommHandle", c_int),             # Communication handle
        ("VMEHandle", c_int),              # VME handle
        ("License", c_char * 999),         # License information
    ]


class Digitizer:
    """
    CAEN Digitizer interface class.
    
    Provides methods for connecting to, configuring, and communicating with
    CAEN digitizer boards. Supports both hardware and test modes.
    """
    
    def __init__(self, link_type: int, link_num: int, board_id: int, vme_address: int):
        """
        Initialize digitizer connection parameters.
        
        Args:
            link_type: Connection type (0=USB, 1=Optical, 2=A4818)
            link_num: Link number for the connection
            board_id: Board identifier
            vme_address: VME address (for VME boards)
        """
        self.logger = logging.getLogger(__name__ + '.Digitizer')
        
        # Connection parameters
        self._link_type = link_type
        self._link_num = link_num
        self._board_id = board_id
        self._vme_address = vme_address
        
        # Connection state
        self._connected = False
        self.__handle = c_int()
        
        self.logger.debug(f"Digitizer initialized: LinkType={link_type}, LinkNum={link_num}, "
                         f"BoardID={board_id}, VMEAddress=0x{vme_address:X}")
    
    def open(self) -> None:
        """
        Open connection to the digitizer board.
        
        Raises:
            RuntimeError: If connection fails
        """
        self.logger.info("Connecting to CAEN digitizer board")
        self.logger.info(f"Link Type: {self._link_type}")
        self.logger.info(f"Link Number: {self._link_num}")
        self.logger.info(f"Board ID: {self._board_id}")
        self.logger.info(f"VME Address: 0x{self._vme_address:X}")
        
        if TEST_FLAG:
            self.logger.warning("Running in test mode - simulating connection")
            self._connected = True
            return
        
        if not self._connected:
            try:
                code = libCAENDigitizer.CAEN_DGTZ_OpenDigitizer(
                    c_long(self._link_type),
                    c_int(self._link_num),
                    c_int(self._board_id),
                    c_uint32(self._vme_address),
                    byref(self.__handle)
                )
                check_error_code(code)
                self._connected = True
                self.logger.info("Successfully connected to digitizer board")
                
            except Exception as e:
                self.logger.error(f"Failed to connect to digitizer: {e}")
                raise
    
    def close(self) -> None:
        """
        Close connection to the digitizer board.
        """
        if TEST_FLAG:
            self.logger.info("Test mode - simulating disconnection")
            self._connected = False
            return
        
        if self._connected:
            try:
                code = libCAENDigitizer.CAEN_DGTZ_CloseDigitizer(self.__handle)
                check_error_code(code)
                self._connected = False
                self.logger.info("Digitizer disconnected successfully")
                
            except Exception as e:
                self.logger.error(f"Error during digitizer disconnection: {e}")
                # Set as disconnected anyway
                self._connected = False
    
    def get_connected(self) -> bool:
        """
        Check if the digitizer is connected.
        
        Returns:
            bool: True if connected, False otherwise
        """
        return self._connected
    
    def get_handle(self) -> c_int:
        """
        Get the internal handle for the digitizer connection.
        
        Returns:
            c_int: CAEN library handle
        """
        return self.__handle
    
    def get_info(self) -> Dict[str, any]:
        """
        Retrieve digitizer board information.
        
        Returns:
            dict: Board information including model, channels, firmware, etc.
        """
        if TEST_FLAG:
            self.logger.info("Test mode - returning simulated board info")
            return {
                "ModelName": "DT5724",
                "Model": 0x5724,
                "Channels": 8,
                "FormFactor": 0,
                "FamilyCode": 0,
                "ROC_FirmwareRel": "2.0.0",
                "AMC_FirmwareRel": "2.0.0",
                "SerialNumber": 12345
            }
        
        try:
            info = BoardInfo()
            code = libCAENDigitizer.CAEN_DGTZ_GetInfo(self.get_handle(), byref(info))
            check_error_code(code)
            
            # Convert structure to dictionary and decode strings
            info_dict = struct2dict(info)
            info_dict["ModelName"] = info_dict["ModelName"].decode('utf-8').rstrip('\x00')
            info_dict["ROC_FirmwareRel"] = info_dict["ROC_FirmwareRel"].decode('utf-8').rstrip('\x00')
            info_dict["AMC_FirmwareRel"] = info_dict["AMC_FirmwareRel"].decode('utf-8').rstrip('\x00')
            
            self.logger.info("Board information retrieved successfully")
            self.logger.debug(f"Board info: {info_dict}")
            
            return info_dict
            
        except Exception as e:
            self.logger.error(f"Failed to get board information: {e}")
            raise
    
    def write_register(self, address: int, data: int) -> None:
        """
        Write data to a digitizer register.
        
        Args:
            address: Register address
            data: Data to write
        """
        if TEST_FLAG:
            self.logger.debug(f"Test mode - simulating register write: 0x{address:X} = 0x{data:X}")
            return
        
        try:
            code = libCAENDigitizer.CAEN_DGTZ_WriteRegister(
                self.get_handle(),
                c_uint32(address),
                c_uint32(data)
            )
            check_error_code(code)
            self.logger.debug(f"Register write: 0x{address:X} = 0x{data:X}")
            
        except Exception as e:
            self.logger.error(f"Failed to write register 0x{address:X}: {e}")
            raise
    
    def read_register(self, address: int) -> int:
        """
        Read data from a digitizer register.
        
        Args:
            address: Register address
            
        Returns:
            int: Register value
        """
        if TEST_FLAG:
            # Return a predictable test value
            test_value = (address & 0xFFFF) ^ 0x1234
            self.logger.debug(f"Test mode - simulating register read: 0x{address:X} = 0x{test_value:X}")
            return test_value
        
        try:
            data = c_uint32()
            code = libCAENDigitizer.CAEN_DGTZ_ReadRegister(
                self.get_handle(),
                c_uint32(address),
                byref(data)
            )
            check_error_code(code)
            
            value = data.value
            self.logger.debug(f"Register read: 0x{address:X} = 0x{value:X}")
            return value
            
        except Exception as e:
            self.logger.error(f"Failed to read register 0x{address:X}: {e}")
            raise
    
    def set_board_id(self) -> None:
        """
        Set the board ID in the hardware register.
        """
        try:
            self.write_register(0xEF08, self._board_id)
            self.logger.info(f"Board ID set to {self._board_id}")
            
        except Exception as e:
            self.logger.error(f"Failed to set board ID: {e}")
            raise
    
    def read_pha(self, file_name: str) -> None:
        """
        Read DPP-PHA configuration from the digitizer and save to JSON file.
        
        This method reads all relevant registers for DPP-PHA (Pulse Height Analysis)
        firmware and saves the configuration to a JSON file for later use.
        
        Args:
            file_name: Path to save the configuration JSON file
        """
        self.logger.info(f"Reading DPP-PHA configuration to {file_name}")
        
        # DPP-PHA register map with descriptions
        register_map: Dict[int, str] = {
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
            0x8100: "Acquisition Control",
            0x810C: "Global Trigger Mask",
            0x8120: "Channel Enable Mask",
            0xEF08: "Board ID",
            0xEF1C: "Aggregate Number per BLT"
        }
        
        self._read_configuration(file_name, register_map, "DPP-PHA")
    
    def read_psd(self, file_name: str) -> None:
        """
        Read DPP-PSD configuration from the digitizer and save to JSON file.
        
        This method reads all relevant registers for DPP-PSD (Pulse Shape Discrimination)
        firmware and saves the configuration to a JSON file for later use.
        
        Args:
            file_name: Path to save the configuration JSON file
        """
        self.logger.info(f"Reading DPP-PSD configuration to {file_name}")
        
        # DPP-PSD register map (similar to PHA with some differences)
        register_map: Dict[int, str] = {
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
            0x8100: "Acquisition Control",
            0x810C: "Global Trigger Mask",
            0x8120: "Channel Enable Mask",
            0xEF08: "Board ID",
            0xEF1C: "Aggregate Number per BLT"
        }
        
        self._read_configuration(file_name, register_map, "DPP-PSD")
    
    def _read_configuration(self, file_name: str, register_map: Dict[int, str], firmware_type: str) -> None:
        """
        Internal method to read configuration from digitizer and save to JSON.
        
        Args:
            file_name: Output file path
            register_map: Dictionary mapping register addresses to descriptions
            firmware_type: Type of firmware (DPP-PHA or DPP-PSD)
        """
        try:
            reg_list = {}
            dgt_list = {}
            
            # Get board information
            info = self.get_info()
            
            if TEST_FLAG:
                self.logger.info(f"Test mode - generating simulated {firmware_type} configuration")
                dgtz = {}
                
                # Generate test values for all registers
                base_value = 0x10
                for reg_address in register_map:
                    reg_addr_str = f"0x{reg_address:04X}"
                    reg_val_str = f"0x{base_value:X}"
                    reg_key = f"reg_{reg_address}"
                    
                    reg_list[reg_key] = {
                        "name": register_map[reg_address],
                        "channel": 0,
                        "address": reg_addr_str,
                        "value": reg_val_str
                    }
                    base_value += 0x10
                
                dgtz["registers"] = reg_list
                
                with open(file_name, 'w') as f:
                    json.dump(dgtz, f, indent=2, ensure_ascii=False)
                
                self.logger.info(f"Test {firmware_type} configuration saved to {file_name}")
                return
            
            # Populate board information
            dgt_list["BoardName"] = str(info["ModelName"])
            dgt_list["Model"] = str(info["Model"])
            dgt_list["NbChannels"] = str(info["Channels"])
            dgt_list["SerialNumber"] = str(info["SerialNumber"])
            dgt_list["LinkNb"] = str(self._link_num)
            dgt_list["BoardNb"] = str(self._board_id)
            dgt_list["ConnectionType"] = str(self._link_type)
            dgt_list["Firmware"] = str(info["ROC_FirmwareRel"])
            
            dgtz = {"dgtzs": dgt_list}
            
            # Read global registers and per-channel registers
            for reg_address, reg_name in register_map.items():
                try:
                    reg_value = self.read_register(reg_address)
                    reg_addr_str = f"0x{reg_address:04X}"
                    reg_val_str = f"0x{reg_value:X}"
                    
                    reg_key = f"reg_{reg_address}"
                    reg_list[reg_key] = {
                        "name": reg_name,
                        "channel": 0,
                        "address": reg_addr_str,
                        "value": reg_val_str
                    }
                    
                    # For per-channel registers (address < 0x2000), read all channels
                    if reg_address < 0x2000:
                        max_offset = 0x100 * info["Channels"]
                        for offset in range(0x100, max_offset, 0x100):
                            current_addr = reg_address + offset
                            channel_num = offset >> 8
                            
                            try:
                                ch_value = self.read_register(current_addr)
                                ch_addr_str = f"0x{current_addr:04X}"
                                ch_val_str = f"0x{ch_value:X}"
                                
                                ch_key = f"reg_{current_addr}"
                                reg_list[ch_key] = {
                                    "name": reg_name,
                                    "channel": channel_num,
                                    "address": ch_addr_str,
                                    "value": ch_val_str
                                }
                                
                            except Exception as e:
                                self.logger.warning(f"Failed to read channel {channel_num} "
                                                  f"register 0x{current_addr:X}: {e}")
                
                except Exception as e:
                    self.logger.warning(f"Failed to read register 0x{reg_address:X}: {e}")
            
            dgtz["registers"] = reg_list
            
            # Save configuration to file
            with open(file_name, 'w') as f:
                json.dump(dgtz, f, indent=2, ensure_ascii=False)
            
            self.logger.info(f"{firmware_type} configuration saved to {file_name}")
            self.logger.info(f"Read {len(reg_list)} registers total")
            
        except Exception as e:
            self.logger.error(f"Failed to read {firmware_type} configuration: {e}")
            raise


# Maintain backward compatibility with the original class name
digitizer = Digitizer