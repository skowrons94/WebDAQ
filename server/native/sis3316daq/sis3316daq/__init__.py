"""Struck SIS3316 digitizer DAQ over Ethernet/UDP, in pure Python."""

from .board import Sis3316
from .daq import DAQ
from .mock import MockSis3316
from .settings import apply_defaults, channel_settings, default_settings, validate
from .transport import Sis3316Error, Sis3316ProtocolError, Sis3316Timeout, UdpLink

__version__ = "1.0.0"
