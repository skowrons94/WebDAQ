"""
Spy Server Utility Module

This module provides Python interfaces for spy servers that monitor real-time
data from XDAQ components during data acquisition runs. It handles communication
with ReadoutUnit (RU) and BuilderUnit (BU) spy servers to collect histograms
and other monitoring data.

Key Features:
- ReadoutUnit spy server interface (ru_spy)
- BuilderUnit spy server interface (bu_spy)
- Real-time histogram collection and buffering
- ROOT-based data handling with memory management
- Thread-safe data collection
- Comprehensive error handling and logging
- Test mode support for development

Author: Scientific DAQ Team
Purpose: Real-time monitoring interface for LUNA experiment XDAQ system
"""

import os
import gc
import time
import threading
import logging
from typing import Dict, List, Optional, Any

# Configure logging
logger = logging.getLogger(__name__)

# Check if running in test mode
TEST_FLAG = os.getenv('TEST_FLAG', False)

# Conditional ROOT import
try:
    import ROOT
    ROOT_AVAILABLE = True
    logger.info("ROOT framework loaded successfully")
except ImportError as e:
    ROOT_AVAILABLE = False
    logger.warning(f"ROOT framework not available: {e}")
    if not TEST_FLAG:
        logger.error("ROOT is required for spy servers in production mode")


class ReadoutUnitSpy:
    """
    Spy server interface for ReadoutUnit (RU) monitoring.
    
    Connects to the ReadoutUnit spy server to collect real-time histograms
    including energy spectra, charge measurements, and waveforms from
    digitizer channels during data acquisition.
    """
    
    def __init__(self, host: str = 'localhost', port: int = 6060):
        """
        Initialize ReadoutUnit spy server interface.
        
        Args:
            host: Hostname of the spy server (default: localhost)
            port: Port number of the spy server (default: 6060)
        """
        self.logger = logging.getLogger(__name__ + '.ReadoutUnitSpy')
        
        # Connection parameters
        self.host = host
        self.port = port
        self.socket = None
        
        # Thread management
        self.running = False
        self.thread = None
        self.collection_interval = 1.0  # seconds
        
        # Initialize ROOT objects if available
        if ROOT_AVAILABLE:
            self._initialize_root_objects()
        else:
            self.logger.warning("Running in test mode or ROOT unavailable - simulation mode")
            self._initialize_test_mode()
    
    def _initialize_root_objects(self) -> None:
        """Initialize ROOT histograms and communication objects."""
        try:
            # ROOT communication objects
            self.default_histo = ROOT.TH1F("Default_Histogram", "Default Histogram", 32768, 0, 32768)
            self.msg = ROOT.TMessage()
            self.obj = ROOT.MakeNullPointer(ROOT.TH1F)
            
            # Initialize histogram buffers and data storage
            # Supports up to 128 channels across all histogram types
            histogram_types = ["energy", "qshort", "qlong", "wave1", "wave2", "psd", "probe1", "probe2"]
            max_channels = 128
            
            # Buffer for temporary storage during collection
            self.buff = {}
            for hist_type in histogram_types:
                self.buff[hist_type] = []
                if( hist_type == "psd" ):
                    # PSD histograms are not provided by RUSpy, fill with null pointers
                    for i in range(max_channels):
                        self.buff[hist_type].append(ROOT.MakeNullPointer(ROOT.TH2F))
                else:
                    for i in range(max_channels):
                        self.buff[hist_type].append(ROOT.MakeNullPointer(ROOT.TH1F))
            
            # Persistent data storage
            self.data = {}
            for hist_type in histogram_types:
                self.data[hist_type] = []
                if( hist_type == "psd" ):
                    for i in range(max_channels):
                        hist_name = f"{hist_type}_ch{i}"
                        hist_title = f"{hist_type.upper()} Channel {i}"
                        self.data[hist_type].append(
                            ROOT.TH2F(hist_name, hist_title, 32768, 0, 32768, 100, 0, 1)
                        )
                elif ("wave" in hist_type):
                    for i in range(max_channels):
                        hist_name = f"{hist_type}_ch{i}"
                        hist_title = f"{hist_type.capitalize()} Channel {i}"
                        self.data[hist_type].append(
                            ROOT.TH1F(hist_name, hist_title, 10000, 0, 10000)
                        )
                elif ("probe" in hist_type):
                    for i in range(max_channels):
                        hist_name = f"{hist_type}_ch{i}"
                        hist_title = f"{hist_type.capitalize()} Channel {i}"
                        self.data[hist_type].append(
                            ROOT.TH1F(hist_name, hist_title, 10000, 0, 10000)
                        )
                else:
                    for i in range(max_channels):
                        hist_name = f"{hist_type}_ch{i}"
                        hist_title = f"{hist_type.capitalize()} Channel {i}"
                        self.data[hist_type].append(
                        ROOT.TH1F(hist_name, hist_title, 32768, 0, 32768)
                    )
            
            self.logger.info("ROOT objects initialized successfully")
            
        except Exception as e:
            self.logger.error(f"Failed to initialize ROOT objects: {e}")
            raise
    
    def _initialize_test_mode(self) -> None:
        """Initialize simulation objects for test mode."""
        # Create placeholder data structures for test mode
        self.buff = {"energy": [], "qshort": [], "qlong": [], "wave1": [], "wave2": [], "psd": [], "probe1": [], "probe2": []}
        self.data = {"energy": [], "qshort": [], "qlong": [], "wave1": [], "wave2": [], "psd": [], "probe1": [], "probe2": []}

        # Fill with None placeholders
        for hist_type in self.buff:
            for i in range(32):
                self.buff[hist_type].append(None)
                self.data[hist_type].append(None)
        
        self.logger.info("Test mode initialized")
    
    def connect(self) -> None:
        """
        Establish connection to the ReadoutUnit spy server.
        
        Raises:
            ConnectionError: If connection fails
        """
        if TEST_FLAG or not ROOT_AVAILABLE:
            self.logger.info("Test mode - simulating spy server connection")
            return
        
        try:
            self.socket = ROOT.TSocket(self.host, self.port)
            if not self.socket.IsValid():
                raise ConnectionError(f"Failed to connect to spy server at {self.host}:{self.port}")
            
            self.logger.debug(f"Connected to ReadoutUnit spy server at {self.host}:{self.port}")
            
        except Exception as e:
            error_msg = f"Error connecting to ReadoutUnit spy server: {e}"
            self.logger.error(error_msg)
            raise ConnectionError(error_msg)
    
    def disconnect(self) -> None:
        """Disconnect from the ReadoutUnit spy server."""
        if TEST_FLAG or not ROOT_AVAILABLE:
            return
        
        try:
            if self.socket:
                self.socket.Close()
                self.logger.debug("Disconnected from ReadoutUnit spy server")
                
        except Exception as e:
            self.logger.warning(f"Error during spy server disconnection: {e}")
    
    def send(self, message: str) -> bool:
        """
        Send a command to the spy server.
        
        Args:
            message: Command string to send
            
        Returns:
            bool: True if successful, False otherwise
        """
        if TEST_FLAG or not ROOT_AVAILABLE:
            self.logger.debug(f"Test mode - simulating send: {message}")
            return True
        
        try:
            if self.socket and self.socket.Send(message) > 0:
                self.logger.debug(f"Sent command to spy server: {message}")
                return True
            else:
                self.logger.warning(f"Failed to send command: {message}")
                return False
                
        except Exception as e:
            self.logger.error(f"Error sending command '{message}': {e}")
            return False
    
    def receive(self) -> Any:
        """
        Receive a histogram object from the spy server.
        
        Returns:
            ROOT histogram object or False if no data
        """
        if TEST_FLAG or not ROOT_AVAILABLE:
            return False
        
        try:
            nbytes = self.socket.Recv(self.msg)
            
            if nbytes <= 0:
                return False
            
            if( "TH2F" in self.msg.GetClass().GetName( )):
                self.obj = ROOT.MakeNullPointer(ROOT.TH2F)
            else:
                self.obj = ROOT.MakeNullPointer(ROOT.TH1F)
            self.obj = self.msg.ReadObject(self.msg.GetClass())
            self.msg.Delete()
            
            return self.obj
            
        except Exception as e:
            self.logger.warning(f"Error receiving data from spy server: {e}")
            return False
    
    def start(self, daq_state: Dict[str, Any]) -> None:
        """
        Start the ReadoutUnit spy server and begin data collection.
        
        Args:
            daq_state: Dictionary containing DAQ configuration including boards and run number
        """
        self.logger.info("Starting ReadoutUnit spy server")
        
        if TEST_FLAG:
            self.logger.info("Test mode - simulating spy server start")
        else:
            try:
                # Build command string for RUSpy executable
                cmd = "RUSpy"
                
                # Add board configurations
                for board in daq_state.get('boards', []):
                    firmware = 0 if board.get('dpp') == "DPP-PHA" else 1
                    board_name = board.get('name', 'unknown')
                    channels = board.get('chan', 8)
                    cmd += f" -d {board_name} {firmware} {channels}"
                
                # Add run number
                run_number = daq_state.get('run', 0)
                cmd += f" -n {run_number}"
                
                self.logger.info(f"Executing spy server command: {cmd}")
                
                # Start the spy server process in background
                os.system(f"{cmd} &")
                
                # Give the spy server time to initialize
                time.sleep(1)
                
            except Exception as e:
                self.logger.error(f"Failed to start ReadoutUnit spy server: {e}")
                raise
        
        # Start data collection thread
        self.running = True
        self.thread = threading.Thread(target=self._collection_loop, daemon=True)
        self.thread.start()
        
        self.logger.info("ReadoutUnit spy data collection started")
    
    def _collection_loop(self) -> None:
        """Main data collection loop running in separate thread."""
        self.logger.debug("Starting data collection loop")
        
        while self.running:
            try:
                self._collect_data()
                time.sleep(self.collection_interval)
                
            except Exception as e:
                self.logger.error(f"Error in data collection loop: {e}")
                time.sleep(self.collection_interval)
        
        self.logger.debug("Data collection loop stopped")
    
    def _collect_data(self) -> None:
        """Collect histogram data from the spy server."""
        if TEST_FLAG or not ROOT_AVAILABLE:
            return
        
        try:
            # Track histogram indices for each type
            histogram_indices = {
                "energy": 0, "qshort": 0, "qlong": 0, "wave1": 0, "wave2": 0, "psd": 0, "probe1": 0, "probe2": 0
            }
            
            # Connect and request data
            self.connect()
            if not self.send("get"):
                self.disconnect()
                return
            
            # Receive all available histograms
            while True:
                obj = self.receive()
                if obj is False:
                    break
                
                # Classify histogram by name and store in buffer
                histogram_name = obj.GetName()
                
                if "Wave1" in histogram_name:
                    idx = histogram_indices["wave1"]
                    if idx < len(self.buff["wave1"]):
                        self.buff["wave1"][idx] = obj
                        histogram_indices["wave1"] += 1
                    else:
                        obj.Delete()
                        
                elif "Wave2" in histogram_name:
                    idx = histogram_indices["wave2"]
                    if idx < len(self.buff["wave2"]):
                        self.buff["wave2"][idx] = obj
                        histogram_indices["wave2"] += 1
                    else:
                        obj.Delete()
                        
                elif "Qshort" in histogram_name:
                    idx = histogram_indices["qshort"]
                    if idx < len(self.buff["qshort"]):
                        self.buff["qshort"][idx] = obj
                        histogram_indices["qshort"] += 1
                    else:
                        obj.Delete()
                        
                elif "Qlong" in histogram_name:
                    idx = histogram_indices["qlong"]
                    if idx < len(self.buff["qlong"]):
                        self.buff["qlong"][idx] = obj
                        histogram_indices["qlong"] += 1
                    else:
                        obj.Delete()
                        
                elif "Energy" in histogram_name:
                    idx = histogram_indices["energy"]
                    if idx < len(self.buff["energy"]):
                        self.buff["energy"][idx] = obj
                        histogram_indices["energy"] += 1
                    else:
                        obj.Delete()

                elif "PSD" in histogram_name:
                    idx = histogram_indices["psd"]
                    if idx < len(self.buff["psd"]):
                        self.buff["psd"][idx] = obj
                        histogram_indices["psd"] += 1
                    else:
                        obj.Delete()

                elif "Probe1" in histogram_name:
                    idx = histogram_indices["probe1"]
                    if idx < len(self.buff["probe1"]):
                        self.buff["probe1"][idx] = obj
                        histogram_indices["probe1"] += 1
                    else:
                        obj.Delete()

                elif "Probe2" in histogram_name:
                    idx = histogram_indices["probe2"]
                    if idx < len(self.buff["probe2"]):
                        self.buff["probe2"][idx] = obj
                        histogram_indices["probe2"] += 1
                    else:
                        obj.Delete()

                else:
                    # Unknown histogram type - clean up
                    obj.Delete()
            
            # Copy buffered data to persistent storage and clean up
            self._process_collected_data()
            
            self.disconnect()
            
        except Exception as e:
            self.logger.error(f"Error during data collection: {e}")
            self.disconnect()
    
    def _process_collected_data(self) -> None:
        """Process collected histogram data and update persistent storage."""
        try:
            for hist_type in self.buff:
                for i, buffered_hist in enumerate(self.buff[hist_type]):
                    if buffered_hist and i < len(self.data[hist_type]):
                        try:
                            # Copy data to persistent histogram (fast)
                            persistent_hist = self.data[hist_type][i]
                            buffered_hist.Copy(persistent_hist)
                            
                            # Clean up buffer
                            buffered_hist.Delete()
                            self.buff[hist_type][i] = ROOT.MakeNullPointer(ROOT.TH1F)
                            
                        except Exception as e:
                            self.logger.warning(f"Error processing histogram {hist_type}[{i}]: {e}")
                            
        except Exception as e:
            self.logger.error(f"Error processing collected data: {e}")
    
    def stop(self) -> None:
        """Stop the ReadoutUnit spy server and data collection."""
        self.logger.info("Stopping ReadoutUnit spy server")
        
        # Stop data collection thread
        self.running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=5)
        
        if TEST_FLAG:
            self.logger.info("Test mode - simulating spy server stop")
            return
        
        try:
            # Try to gracefully stop the spy server
            self.connect()
            self.send("stop")
            self.disconnect()
            
        except Exception as e:
            self.logger.warning(f"Error during graceful shutdown: {e}")
            # Force kill as fallback
            try:
                os.system("killall RUSpy")
                self.logger.info("Forced termination of RUSpy process")
            except Exception as kill_error:
                self.logger.error(f"Failed to force kill RUSpy: {kill_error}")
        
        self.logger.info("ReadoutUnit spy server stopped")
    
    def get_object(self, histogram_type: str, channel_index: int) -> Any:
        """
        Retrieve a histogram object for a specific type and channel.
        
        Args:
            histogram_type: Type of histogram ('energy', 'qshort', 'qlong', 'wave1', 'wave2')
            channel_index: Channel index (0-31)
            
        Returns:
            ROOT histogram object (clone) or default histogram if not available
        """
        try:
            if (histogram_type in self.data and 
                0 <= channel_index < len(self.data[histogram_type]) and
                self.data[histogram_type][channel_index] is not None):
                
                if ROOT_AVAILABLE:
                    if( TEST_FLAG ):
                        if( histogram_type == "psd" ):
                            # PSD histograms are not provided by RUSpy, fill with gaussian data
                            hist = self.data[histogram_type][channel_index]
                            hist.Reset()
                            for x_bin in range(1, hist.GetNbinsX() + 1):
                                for y_bin in range(1, hist.GetNbinsY() + 1):
                                    content = ROOT.gRandom.Gaus(10000, 100)
                                    hist.SetBinContent(x_bin, y_bin, content)
                            return hist.Clone()
                        else:
                            # Fill with gaussian data with mean=10000, sigma=100
                            hist = self.data[histogram_type][channel_index]
                            hist.Reset()
                            for bin_idx in range(1, hist.GetNbinsX() + 1):
                                content = ROOT.gRandom.Gaus(10000, 100)
                                hist.SetBinContent(bin_idx, content)
                            return hist.Clone()
                    else:
                        return self.data[histogram_type][channel_index].Clone()
                else:
                    # Return placeholder in test mode
                    return None
            else:
                self.logger.debug(f"Histogram not available: {histogram_type}[{channel_index}]")
                
        except Exception as e:
            self.logger.warning(f"Error retrieving histogram {histogram_type}[{channel_index}]: {e}")
        
        # Return default histogram as fallback
        if ROOT_AVAILABLE:
            return self.default_histo.Clone()
        else:
            return None
    
    def get_connection_status(self) -> Dict[str, Any]:
        """
        Get current connection and status information.
        
        Returns:
            Dictionary with status information
        """
        return {
            'host': self.host,
            'port': self.port,
            'running': self.running,
            'thread_alive': self.thread.is_alive() if self.thread else False,
            'test_mode': TEST_FLAG,
            'root_available': ROOT_AVAILABLE,
            'collection_interval': self.collection_interval
        }


class BuilderUnitSpy:
    """
    Spy server interface for BuilderUnit (BU) monitoring.
    
    Connects to the BuilderUnit spy server to collect coincidence analysis
    histograms and anti-coincidence data during data acquisition.
    """
    
    def __init__(self, host: str = 'localhost', port: int = 7070):
        """
        Initialize BuilderUnit spy server interface.
        
        Args:
            host: Hostname of the spy server (default: localhost)
            port: Port number of the spy server (default: 7070)
        """
        self.logger = logging.getLogger(__name__ + '.BuilderUnitSpy')
        
        # Connection parameters
        self.host = host
        self.port = port
        self.socket = None
        
        # Thread management
        self.running = False
        self.thread = None
        self.collection_interval = 1.0  # seconds
        
        # Initialize ROOT objects if available
        if ROOT_AVAILABLE and not TEST_FLAG:
            self._initialize_root_objects()
        else:
            self.logger.warning("Running in test mode or ROOT unavailable - simulation mode")
            self._initialize_test_mode()
    
    def _initialize_root_objects(self) -> None:
        """Initialize ROOT histograms and communication objects for BU spy."""
        try:
            # ROOT communication objects
            self.default_histo = ROOT.TH1F("Default_BU_Histogram", "Default BU Histogram", 32768, 0, 32768)
            self.msg = ROOT.TMessage()
            self.obj = ROOT.MakeNullPointer(ROOT.TH1F)
            
            # BuilderUnit histogram types (coincidence analysis)
            histogram_types = ["energyAnti", "qshortAnti", "qlongAnti", "energySum", "qshortSum", "qlongSum"]
            max_channels = 128
            
            # Buffer and data storage initialization
            self.buff = {}
            self.data = {}
            
            for hist_type in histogram_types:
                self.buff[hist_type] = []
                self.data[hist_type] = []
                
                for i in range(max_channels):
                    self.buff[hist_type].append(ROOT.MakeNullPointer(ROOT.TH1F))
                    
                    hist_name = f"{hist_type}_ch{i}"
                    hist_title = f"{hist_type.capitalize()} Channel {i}"
                    self.data[hist_type].append(
                        ROOT.TH1F(hist_name, hist_title, 32768, 0, 32768)
                    )
            
            self.logger.info("BuilderUnit ROOT objects initialized successfully")
            
        except Exception as e:
            self.logger.error(f"Failed to initialize BuilderUnit ROOT objects: {e}")
            raise
    
    def _initialize_test_mode(self) -> None:
        """Initialize simulation objects for test mode."""
        histogram_types = ["energyAnti", "qshortAnti", "qlongAnti", "energySum", "qshortSum", "qlongSum"]
        
        self.buff = {}
        self.data = {}
        
        for hist_type in histogram_types:
            self.buff[hist_type] = [None] * 32
            self.data[hist_type] = [None] * 32
        
        self.logger.info("BuilderUnit test mode initialized")
    
    # Similar methods to ReadoutUnitSpy with BU-specific adaptations
    def connect(self) -> None:
        """Establish connection to BuilderUnit spy server."""
        if TEST_FLAG or not ROOT_AVAILABLE:
            self.logger.info("Test mode - simulating BU spy server connection")
            return
        
        try:
            self.socket = ROOT.TSocket(self.host, self.port)
            if not self.socket.IsValid():
                raise ConnectionError(f"Failed to connect to BU spy server at {self.host}:{self.port}")
            
            self.logger.debug(f"Connected to BuilderUnit spy server at {self.host}:{self.port}")
            
        except Exception as e:
            error_msg = f"Error connecting to BuilderUnit spy server: {e}"
            self.logger.error(error_msg)
            raise ConnectionError(error_msg)
    
    def disconnect(self) -> None:
        """Disconnect from BuilderUnit spy server."""
        if TEST_FLAG or not ROOT_AVAILABLE:
            return
        
        try:
            if self.socket:
                self.socket.Close()
                self.logger.debug("Disconnected from BuilderUnit spy server")
        except Exception as e:
            self.logger.warning(f"Error during BU spy server disconnection: {e}")
    
    def get_object(self, histogram_type: str, channel_index: int) -> Any:
        """
        Retrieve BuilderUnit histogram object.
        
        Args:
            histogram_type: BU histogram type (e.g., 'energyAnti', 'energySum')
            channel_index: Channel index
            
        Returns:
            ROOT histogram object or default histogram
        """
        try:
            if (histogram_type in self.data and 
                0 <= channel_index < len(self.data[histogram_type]) and
                self.data[histogram_type][channel_index] is not None):
                
                if ROOT_AVAILABLE and not TEST_FLAG:
                    return self.data[histogram_type][channel_index].Clone()
                else:
                    return None
            else:
                self.logger.debug(f"BU histogram not available: {histogram_type}[{channel_index}]")
                
        except Exception as e:
            self.logger.warning(f"Error retrieving BU histogram {histogram_type}[{channel_index}]: {e}")
        
        # Return default histogram as fallback
        if ROOT_AVAILABLE and not TEST_FLAG:
            return self.default_histo.Clone()
        else:
            return None


# Maintain backward compatibility with original class names
ru_spy = ReadoutUnitSpy
bu_spy = BuilderUnitSpy