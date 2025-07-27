"""
Spy Manager Module

This module provides centralized management of spy server operations for real-time
monitoring of data acquisition. It encapsulates the spy functionality from the 
experiment routes to improve code organization and maintainability.

Key Features:
- ReadoutUnit spy server management
- Histogram collection and retrieval
- Waveform data access
- ROI (Region of Interest) calculations
- Thread-safe spy operations
- Waveform activation/deactivation control

Author: WebDAQ Refactoring
Purpose: Centralized spy server management for LUNA experiment
"""

import os
import json
import logging
from typing import Dict, List, Optional, Any, Tuple

from ..utils.spy import ru_spy

logger = logging.getLogger(__name__)

class SpyManager:
    """
    Centralized manager for spy server operations and histogram data.
    
    Manages the ReadoutUnit spy server, histogram collection, and provides
    convenient access to monitoring data for the web interface.
    """
    
    def __init__(self, test_flag: bool = False):
        """
        Initialize Spy Manager.
        
        Args:
            test_flag: Enable test mode for development
        """
        self.logger = logging.getLogger(__name__ + '.SpyManager')
        self.test_flag = test_flag
        
        # Initialize ReadoutUnit spy server
        self.ru_spy = ru_spy()
        self.logger.info("Spy manager initialized")
    
    def start_spy(self, daq_state: Dict[str, Any]) -> bool:
        """
        Start the ReadoutUnit spy server.
        
        Args:
            daq_state: DAQ configuration including boards and run information
            
        Returns:
            True if start successful, False otherwise
        """
        try:
            self.ru_spy.start(daq_state)
            self.logger.info("ReadoutUnit spy server started")
            return True
        except Exception as e:
            self.logger.error(f"Error starting spy server: {e}")
            return False
    
    def stop_spy(self) -> bool:
        """
        Stop the ReadoutUnit spy server.
        
        Returns:
            True if stop successful, False otherwise
        """
        try:
            self.ru_spy.stop()
            self.logger.info("ReadoutUnit spy server stopped")
            return True
        except Exception as e:
            self.logger.error(f"Error stopping spy server: {e}")
            return False
    
    def get_histogram_index(self, board_id: str, channel: int, boards: List[Dict[str, Any]]) -> Tuple[int, str]:
        """
        Calculate histogram index and get DPP type for a specific board/channel.
        
        Args:
            board_id: Board ID string
            channel: Channel number
            boards: List of board configurations
            
        Returns:
            Tuple of (histogram_index, dpp_type)
        """
        idx = 0
        dpp = "DPP-PHA"  # default
        
        try:
            for board in boards:
                if int(board['id']) < int(board_id):
                    idx += board['chan']
                elif int(board['id']) == int(board_id):
                    dpp = board['dpp']
                    break
            
            idx += int(channel)
            
        except Exception as e:
            self.logger.warning(f"Error calculating histogram index: {e}")
        
        return idx, dpp
    
    def get_histogram(self, board_id: str, channel: int, boards: List[Dict[str, Any]], 
                     histogram_type: Optional[str] = None, rebin: int = 16) -> Any:
        """
        Get histogram for a specific board and channel.
        
        Args:
            board_id: Board ID string
            channel: Channel number
            boards: List of board configurations
            histogram_type: Specific histogram type or None for auto-detection
            rebin: Rebin factor for histogram
            
        Returns:
            ROOT histogram object or None
        """
        try:
            idx, dpp = self.get_histogram_index(board_id, channel, boards)
            
            # Determine histogram type based on DPP if not specified
            if histogram_type is None:
                if dpp == "DPP-PHA":
                    histogram_type = "energy"
                else:
                    histogram_type = "qlong"
            
            # Get histogram from spy server
            histo = self.ru_spy.get_object(histogram_type, idx)
            
            if histo and rebin > 1:
                histo.Rebin(rebin)
            
            return histo
            
        except Exception as e:
            self.logger.error(f"Error getting histogram for board {board_id}, channel {channel}: {e}")
            return None
    
    def get_waveform(self, board_id: str, channel: int, boards: List[Dict[str, Any]], 
                    waveform_type: str = "wave1") -> Any:
        """
        Get waveform data for a specific board and channel.
        
        Args:
            board_id: Board ID string
            channel: Channel number
            boards: List of board configurations
            waveform_type: Type of waveform ("wave1" or "wave2")
            
        Returns:
            ROOT waveform object or None
        """
        try:
            idx, _ = self.get_histogram_index(board_id, channel, boards)
            waveform = self.ru_spy.get_object(waveform_type, idx)
            return waveform
            
        except Exception as e:
            self.logger.error(f"Error getting waveform {waveform_type} for board {board_id}, channel {channel}: {e}")
            return None
    
    def get_roi_integral(self, board_id: str, channel: int, boards: List[Dict[str, Any]], 
                        roi_min: int, roi_max: int, rebin: int = 16) -> float:
        """
        Calculate ROI (Region of Interest) integral for a histogram.
        
        Args:
            board_id: Board ID string
            channel: Channel number
            boards: List of board configurations
            roi_min: Minimum ROI value
            roi_max: Maximum ROI value
            rebin: Rebin factor for histogram
            
        Returns:
            Integral value or 0.0 if error
        """
        try:
            histo = self.get_histogram(board_id, channel, boards, rebin=rebin)
            
            if histo:
                integral = histo.Integral(
                    histo.FindBin(roi_min), 
                    histo.FindBin(roi_max)
                )
                return float(integral)
            else:
                return 0.0
                
        except Exception as e:
            self.logger.error(f"Error calculating ROI integral: {e}")
            return 0.0
    
    def get_roi_histogram(self, board_id: str, channel: int, boards: List[Dict[str, Any]], 
                         roi_min: int, roi_max: int, rebin: int = 16) -> Any:
        """
        Get histogram with ROI highlighting.
        
        Args:
            board_id: Board ID string
            channel: Channel number
            boards: List of board configurations
            roi_min: Minimum ROI value
            roi_max: Maximum ROI value
            rebin: Rebin factor for histogram
            
        Returns:
            ROOT histogram object with ROI styling or None
        """
        try:
            from ROOT import TH1F
            
            histo = self.get_histogram(board_id, channel, boards, rebin=rebin)
            
            if histo:
                # Create ROI highlighted histogram
                h1 = TH1F(histo)
                h1.GetXaxis().SetRange(h1.FindBin(roi_min), h1.FindBin(roi_max) - 1)
                h1.SetLineColor(2)
                h1.SetFillStyle(3001)
                h1.SetFillColorAlpha(2, 0.3)
                h1.SetLineWidth(2)
                
                # Return original histogram (ROI highlighting is for display)
                del h1
                return histo
            else:
                return None
                
        except Exception as e:
            self.logger.error(f"Error creating ROI histogram: {e}")
            return None
    
    def activate_waveforms(self, boards: List[Dict[str, Any]]) -> bool:
        """
        Activate waveform recording for all boards.
        
        Args:
            boards: List of board configurations
            
        Returns:
            True if successful, False otherwise
        """
        try:
            for board in boards:
                filename = f"conf/{board['name']}_{board['id']}.json"
                
                if os.path.exists(filename):
                    with open(filename, 'r') as f:
                        data = json.load(f)
                    
                    # Enable waveform bit in register 0x8000
                    reg_key = 'reg_8000'
                    if reg_key in data.get('registers', {}):
                        string_value = data['registers'][reg_key]["value"]
                        value = int(string_value, 16)
                        value |= 1 << 16  # Set bit 16
                        data['registers'][reg_key]["value"] = hex(value)
                        
                        with open(filename, 'w') as f:
                            json.dump(data, f, indent=4)
                    else:
                        self.logger.warning(f"Register {reg_key} not found in {filename}")
                else:
                    self.logger.warning(f"Configuration file not found: {filename}")
            
            self.logger.info("Waveforms activated for all boards")
            return True
            
        except Exception as e:
            self.logger.error(f"Error activating waveforms: {e}")
            return False
    
    def deactivate_waveforms(self, boards: List[Dict[str, Any]]) -> bool:
        """
        Deactivate waveform recording for all boards.
        
        Args:
            boards: List of board configurations
            
        Returns:
            True if successful, False otherwise
        """
        try:
            for board in boards:
                filename = f"conf/{board['name']}_{board['id']}.json"
                
                if os.path.exists(filename):
                    with open(filename, 'r') as f:
                        data = json.load(f)
                    
                    # Disable waveform bit in register 0x8000
                    reg_key = 'reg_8000'
                    if reg_key in data.get('registers', {}):
                        string_value = data['registers'][reg_key]["value"]
                        value = int(string_value, 16)
                        value &= ~(1 << 16)  # Clear bit 16
                        data['registers'][reg_key]["value"] = hex(value)
                        
                        with open(filename, 'w') as f:
                            json.dump(data, f, indent=4)
                    else:
                        self.logger.warning(f"Register {reg_key} not found in {filename}")
                else:
                    self.logger.warning(f"Configuration file not found: {filename}")
            
            self.logger.info("Waveforms deactivated for all boards")
            return True
            
        except Exception as e:
            self.logger.error(f"Error deactivating waveforms: {e}")
            return False
    
    def get_waveform_status(self, boards: List[Dict[str, Any]]) -> bool:
        """
        Check if waveforms are currently enabled.
        
        Args:
            boards: List of board configurations
            
        Returns:
            True if waveforms are enabled for all boards, False otherwise
        """
        try:
            for board in boards:
                filename = f"conf/{board['name']}_{board['id']}.json"
                
                if os.path.exists(filename):
                    with open(filename, 'r') as f:
                        data = json.load(f)
                    
                    # Check waveform bit in register 0x8000
                    reg_key = 'reg_8000'
                    if reg_key in data.get('registers', {}):
                        string_value = data['registers'][reg_key]["value"]
                        value = int(string_value, 16)
                        if (value & (1 << 16)) == 0:
                            return False
                    else:
                        self.logger.warning(f"Register {reg_key} not found in {filename}")
                        return False
                else:
                    self.logger.warning(f"Configuration file not found: {filename}")
                    return False
            
            return True
            
        except Exception as e:
            self.logger.error(f"Error checking waveform status: {e}")
            return False
    
    def convert_histogram_to_json(self, histogram) -> Optional[str]:
        """
        Convert ROOT histogram to JSON format.
        
        Args:
            histogram: ROOT histogram object
            
        Returns:
            JSON string representation or None if error
        """
        try:
            from ROOT import TBufferJSON
            
            if histogram:
                obj = TBufferJSON.ConvertToJSON(histogram)
                return str(obj.Data())
            else:
                return None
                
        except Exception as e:
            self.logger.error(f"Error converting histogram to JSON: {e}")
            return None
    
    def get_spy_status(self) -> Dict[str, Any]:
        """
        Get current spy server status information.
        
        Returns:
            Dictionary with spy server status
        """
        try:
            if hasattr(self.ru_spy, 'get_connection_status'):
                return self.ru_spy.get_connection_status()
            else:
                # Fallback status info
                return {
                    'running': hasattr(self.ru_spy, 'running') and self.ru_spy.running,
                    'test_mode': self.test_flag,
                    'spy_type': 'ReadoutUnit'
                }
        except Exception as e:
            self.logger.error(f"Error getting spy status: {e}")
            return {'error': str(e)}


# Global instance - will be initialized by the application
spy_manager = None

def get_spy_manager(test_flag: bool = False) -> SpyManager:
    """
    Get or create the global spy manager instance.
    
    Args:
        test_flag: Enable test mode
        
    Returns:
        Spy manager instance
    """
    global spy_manager
    if spy_manager is None:
        spy_manager = SpyManager(test_flag=test_flag)
    return spy_manager