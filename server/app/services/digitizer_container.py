"""
DigitizerContainer — persistent CAEN digitizer connections.

Keeps the boards open (via the ctypes ``digitizer`` wrapper) so the app can probe
them (board info, register reads, connectivity) without repeated open/close. The
connections are released to caendaq during a run and reacquired afterwards.

Extracted from daq_manager.py so that module stays focused on run/state control.
"""

import time
import logging
import threading
from typing import Dict, List, Optional, Any

from ..utils.dgtz import digitizer

logger = logging.getLogger(__name__)


class DigitizerContainer:
    """Manage persistent digitizer connections, keyed by board id."""

    def __init__(self, test_flag: bool = False):
        self.logger = logging.getLogger(__name__ + '.DigitizerContainer')
        self.test_flag = test_flag
        self.digitizers: Dict[str, digitizer] = {}          # board_id -> digitizer
        self.connection_locks: Dict[str, threading.Lock] = {}  # board_id -> lock

    def _create_digitizer(self, board_config: Dict[str, Any]) -> Optional[digitizer]:
        """Create and open a digitizer connection with retry logic."""
        if self.test_flag:
            return None

        link_type_map = {"USB": 0, "Optical": 1, "A4818": 5}
        link_type = link_type_map.get(board_config["link_type"], 0)

        dgtz = digitizer(
            link_type,
            int(board_config["link_num"]),
            int(board_config["id"]),
            int(board_config["vme"], 16),
        )

        for attempt in range(3):
            try:
                dgtz.open()
                if dgtz.get_connected():
                    self.logger.info(f"Connected to board {board_config['id']} on attempt {attempt + 1}")
                    return dgtz
                self.logger.warning(f"Failed to connect to board {board_config['id']} on attempt {attempt + 1}")
            except Exception as e:
                self.logger.error(f"Exception connecting to board {board_config['id']} attempt {attempt + 1}: {e}")
            if attempt < 2:
                time.sleep(1.0)

        self.logger.error(f"Failed to connect to board {board_config['id']} after 3 attempts")
        return None

    def add_board(self, board_config: Dict[str, Any]) -> bool:
        """Add a board and create its persistent connection."""
        board_id = str(board_config['id'])
        self.connection_locks[board_id] = threading.Lock()
        dgtz = self._create_digitizer(board_config)
        if dgtz is not None:
            self.digitizers[board_id] = dgtz
            self.logger.info(f"Added persistent connection for board {board_id}")
            return True
        self.connection_locks.pop(board_id, None)
        return False

    def remove_board(self, board_id: str) -> None:
        """Remove a board and close its connection."""
        board_id = str(board_id)
        if board_id in self.digitizers:
            try:
                self.digitizers[board_id].close()
                self.logger.info(f"Closed connection for board {board_id}")
            except Exception as e:
                self.logger.error(f"Error closing connection for board {board_id}: {e}")
            del self.digitizers[board_id]
        self.connection_locks.pop(board_id, None)

    def get_digitizer(self, board_id: str) -> Optional[digitizer]:
        return self.digitizers.get(str(board_id))

    def get_connection_lock(self, board_id: str) -> Optional[threading.Lock]:
        return self.connection_locks.get(str(board_id))

    def is_connected(self, board_id: str) -> bool:
        if self.test_flag:
            return True
        dgtz = self.get_digitizer(board_id)
        if dgtz is None:
            return False
        try:
            return dgtz.get_connected()
        except Exception as e:
            self.logger.error(f"Error checking connection for board {board_id}: {e}")
            return False

    def read_register(self, board_id: str, address: int) -> Optional[int]:
        if self.test_flag:
            return 0
        dgtz = self.get_digitizer(board_id)
        if dgtz is None:
            return None
        lock = self.get_connection_lock(board_id)
        if lock is None:
            return None
        try:
            with lock:
                if dgtz.get_connected():
                    return dgtz.read_register(address)
                self.logger.warning(f"Board {board_id} not connected for register read")
                return None
        except Exception as e:
            self.logger.error(f"Error reading register 0x{address:X} from board {board_id}: {e}")
            return None

    def write_register(self, board_id: str, address: int, value: int) -> bool:
        """
        Write a register through the probe connection.

        Only usable between runs: during a run these handles are closed and the
        boards belong to caendaq (see DAQManager.release_digitizers).
        """
        if self.test_flag:
            self.logger.info(f"Test mode: pretending to write 0x{value:X} to 0x{address:X} "
                             f"on board {board_id}")
            return True
        dgtz = self.get_digitizer(board_id)
        if dgtz is None:
            return False
        lock = self.get_connection_lock(board_id)
        if lock is None:
            return False
        try:
            with lock:
                if not dgtz.get_connected():
                    self.logger.warning(f"Board {board_id} not connected for register write")
                    return False
                dgtz.write_register(address, value)
                return True
        except Exception as e:
            self.logger.error(f"Error writing 0x{value:X} to register 0x{address:X} "
                              f"on board {board_id}: {e}")
            return False

    def refresh_board_connection(self, board_id: str, board_config: Dict[str, Any]) -> bool:
        """Close and reopen a board's connection."""
        self.remove_board(board_id)
        return self.add_board(board_config)

    def get_all_board_ids(self) -> List[str]:
        return list(self.digitizers.keys())

    def cleanup(self) -> None:
        """Close all connections."""
        for board_id, dgtz in self.digitizers.items():
            try:
                dgtz.close()
                self.logger.info(f"Closed connection for board {board_id}")
            except Exception as e:
                self.logger.error(f"Error closing connection for board {board_id}: {e}")
        self.digitizers.clear()
        self.connection_locks.clear()
