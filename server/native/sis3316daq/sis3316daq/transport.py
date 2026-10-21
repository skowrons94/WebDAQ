"""
UDP transport to one SIS3316 (SIS3316 Ethernet UDP addendum, sec. 3).

The board answers on UDP port 0xE000 to whatever port the request came from.
Every value on the wire is little-endian. Two protocol generations exist:

* VME FPGA firmware below V3316-2008: no packet identifier byte.
* V3316-2008 and later: a packet identifier byte follows the command byte and
  is echoed in the acknowledge, which lets lost/stale packets be detected.

The generation is detected on open() from the length of the answer to a link
register read, so the same code drives old and new boards.
"""

import socket
import struct
import threading
import time
from typing import Iterable, List, Sequence, Tuple

import numpy as np

UDP_PORT = 0xE000
# Firmware before V3316-2008 answers to port 0xE000 whatever the request's
# source port, so the PC socket must be bound to it: one socket per PC talks
# to such a board at a time.
LOCAL_PORT = 0xE000

CMD_LINK_READ = 0x10
CMD_LINK_WRITE = 0x11
CMD_REG_READ = 0x20
CMD_REG_WRITE = 0x21
CMD_FIFO_READ = 0x30
CMD_FIFO_WRITE = 0x31
CMD_RETRANSMIT = 0xEE
CMD_RESET = 0xFF

MAX_REGS_PER_REQUEST = 64       # register read/write requests
WORDS_PER_PACKET = 360          # FIFO data per (non-jumbo) answer packet
MAX_PACKETS_PER_REQUEST = 32    # SIS limit; more risks overrunning the socket


class Sis3316Error(Exception):
    """Base error for the SIS3316 driver."""


class Sis3316Timeout(Sis3316Error):
    """The board did not answer in time."""


class Sis3316ProtocolError(Sis3316Error):
    """The board answered, but not with what was asked for."""


def _status_error(status: int) -> str:
    problems = []
    if status & 0x40:
        problems.append("protocol error")
    if status & 0x20:
        problems.append("SIS3316 access timeout")
    if status & 0x10:
        problems.append("Ethernet interface has no grant")
    return ", ".join(problems)


class UdpLink:
    """Register and FIFO access to one SIS3316 over UDP.

    All public methods are thread safe: one request/answer exchange at a time.
    """

    def __init__(self, host: str, port: int = UDP_PORT, local_ip: str = "",
                 local_port: int = LOCAL_PORT, timeout: float = 0.1, retries: int = 3):
        self.host = host
        self.port = int(port)
        self.local_ip = local_ip
        self.local_port = int(local_port)
        self.timeout = float(timeout)
        self.retries = int(retries)
        self.packet_id_mode = False     # True for VME FPGA >= V3316-2008
        self._pid = 0
        self._sock = None
        self._lock = threading.RLock()
        # Counters, for diagnostics
        self.timeouts = 0
        self.retransmits = 0
        self.bytes_read = 0

    # ── socket ─────────────────────────────────────────────────────────────
    def open(self) -> None:
        with self._lock:
            if self._sock is not None:
                return
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 * 1024 * 1024)
            try:
                sock.bind((self.local_ip, self.local_port))
            except OSError as e:
                sock.close()
                raise Sis3316Error(
                    f"cannot bind UDP port 0x{self.local_port:04x} for the SIS3316 "
                    f"({e}); another program is talking to the board") from None
            sock.settimeout(self.timeout)
            self._sock = sock
            self._detect_protocol()

    def close(self) -> None:
        with self._lock:
            if self._sock is not None:
                self._sock.close()
                self._sock = None

    @property
    def is_open(self) -> bool:
        return self._sock is not None

    def _send(self, payload: bytes) -> None:
        self._sock.sendto(payload, (self.host, self.port))

    def _recv(self, timeout: float = None) -> bytes:
        if timeout is not None:
            self._sock.settimeout(timeout)
        try:
            data, _ = self._sock.recvfrom(9100)
            return data
        except socket.timeout:
            self.timeouts += 1
            raise Sis3316Timeout(f"no answer from SIS3316 at {self.host}")
        finally:
            if timeout is not None:
                self._sock.settimeout(self.timeout)

    def _drain(self) -> None:
        """Throw away anything left in the socket (late answers, retries)."""
        self._sock.settimeout(0)
        try:
            while True:
                self._sock.recvfrom(9100)
        except (BlockingIOError, socket.timeout, OSError):
            pass
        finally:
            self._sock.settimeout(self.timeout)

    def _next_pid(self) -> int:
        self._pid = (self._pid + 1) & 0xFF
        return self._pid

    def _detect_protocol(self) -> None:
        """Pick the protocol generation from the shape of a link register read.

        A new-protocol request ``[0x10, id, addr32]`` is answered by new firmware
        with ``[0x10, id, addr32, data32]`` (10 bytes). Old firmware reads the id
        byte as the low address byte and answers in its own 9-byte format.
        """
        self._drain()
        last = None
        for _ in range(self.retries):
            pid = self._next_pid()
            self._send(struct.pack("<BBI", CMD_LINK_READ, pid, 0x4))
            try:
                ans = self._recv()
            except Sis3316Timeout as e:
                last = e
                continue
            if len(ans) == 10 and ans[0] == CMD_LINK_READ and ans[1] == pid:
                self.packet_id_mode = True
                return
            if len(ans) == 9 and ans[0] == CMD_LINK_READ:
                self.packet_id_mode = False
                return
            last = Sis3316ProtocolError(f"unexpected answer {ans.hex()}")
        raise last or Sis3316Timeout(f"no answer from SIS3316 at {self.host}")

    def _header(self, cmd: int) -> bytes:
        if self.packet_id_mode:
            return struct.pack("<BB", cmd, self._next_pid())
        return struct.pack("<B", cmd)

    def _check_pid(self, ans: bytes, sent: bytes) -> None:
        if self.packet_id_mode and ans[1] != sent[1]:
            raise Sis3316ProtocolError("stale answer (packet identifier mismatch)")

    def _exchange(self, request: bytes, cmd: int, min_len: int) -> bytes:
        """Send a request and return its single-packet answer, with retries."""
        last = None
        for attempt in range(self.retries):
            if attempt:
                self._drain()
            self._send(request)
            try:
                ans = self._recv()
            except Sis3316Timeout as e:
                last = e
                continue
            if ans[0] != cmd or len(ans) < min_len:
                last = Sis3316ProtocolError(
                    f"answer 0x{ans[0]:02x}/{len(ans)} bytes to command 0x{cmd:02x}")
                continue
            try:
                self._check_pid(ans, request)
            except Sis3316ProtocolError as e:
                last = e
                continue
            return ans
        raise last

    # ── link interface registers (0x00-0x1C) ───────────────────────────────
    def link_read(self, addr: int) -> int:
        with self._lock:
            req = self._header(CMD_LINK_READ) + struct.pack("<I", addr)
            off = 2 if self.packet_id_mode else 1
            ans = self._exchange(req, CMD_LINK_READ, off + 8)
            return struct.unpack_from("<I", ans, off + 4)[0]

    def link_write(self, addr: int, value: int) -> None:
        # No acknowledge exists for link writes, in either protocol.
        with self._lock:
            self._send(struct.pack("<BII", CMD_LINK_WRITE, addr, value & 0xFFFFFFFF))

    # ── SIS3316 register space ─────────────────────────────────────────────
    @staticmethod
    def _batches(items: Sequence, addr_of) -> List[Sequence]:
        """Split register accesses into requests.

        Only VME FPGA registers (below 0x1000) share a request. Multi-register
        requests that touch the ADC FPGAs were measured to misplace data on
        VME FPGA V3316-2004: a read returns the value of the previous read of
        the same ADC FPGA, and writes land on the neighbouring register or are
        dropped. One request per ADC FPGA register is always correct.
        """
        out: List[Sequence] = []
        run: List = []
        for item in items:
            if addr_of(item) >= 0x1000:
                if run:
                    out.append(run)
                    run = []
                out.append([item])
            else:
                run.append(item)
                if len(run) == MAX_REGS_PER_REQUEST:
                    out.append(run)
                    run = []
        if run:
            out.append(run)
        return out

    def read_list(self, addrs: Sequence[int]) -> List[int]:
        out: List[int] = []
        with self._lock:
            for chunk in self._batches(list(addrs), lambda a: a):
                req = (self._header(CMD_REG_READ)
                       + struct.pack("<H", len(chunk) - 1)
                       + struct.pack(f"<{len(chunk)}I", *chunk))
                off = 3 if self.packet_id_mode else 2
                ans = self._exchange(req, CMD_REG_READ, off)
                status = ans[off - 1]
                if _status_error(status):
                    raise Sis3316ProtocolError(
                        f"register read 0x{chunk[0]:04x}: {_status_error(status)}")
                if len(ans) < off + 4 * len(chunk):
                    raise Sis3316ProtocolError("short register read answer")
                out.extend(struct.unpack_from(f"<{len(chunk)}I", ans, off))
        return out

    def read(self, addr: int) -> int:
        return self.read_list([addr])[0]

    def write_list(self, pairs: Iterable[Tuple[int, int]]) -> None:
        pairs = list(pairs)
        with self._lock:
            for chunk in self._batches(pairs, lambda p: p[0]):
                body = b"".join(struct.pack("<II", a, v & 0xFFFFFFFF) for a, v in chunk)
                req = self._header(CMD_REG_WRITE) + struct.pack("<H", len(chunk) - 1) + body
                off = 3 if self.packet_id_mode else 2
                ans = self._exchange(req, CMD_REG_WRITE, off)
                status = ans[off - 1]
                if _status_error(status):
                    raise Sis3316ProtocolError(
                        f"register write 0x{chunk[0][0]:04x}: {_status_error(status)}")

    def write(self, addr: int, value: int) -> None:
        self.write_list([(addr, value)])

    # ── memory (FIFO) space ────────────────────────────────────────────────
    def fifo_write(self, addr: int, data: np.ndarray) -> None:
        """Write 32-bit words to a memory FIFO address (after a "Start Write
        Transfer" command), at most 256 words per request."""
        data = np.ascontiguousarray(data, dtype="<u4")
        off = 3 if self.packet_id_mode else 2
        with self._lock:
            for i in range(0, data.size, 256):
                chunk = data[i:i + 256]
                req = (self._header(CMD_FIFO_WRITE)
                       + struct.pack("<HI", chunk.size - 1, addr) + chunk.tobytes())
                ans = self._exchange(req, CMD_FIFO_WRITE, off)
                status = ans[off - 1]
                if status & 0x70:
                    raise Sis3316ProtocolError(f"FIFO write: {_status_error(status)}")

    def fifo_read(self, addr: int, nwords: int) -> np.ndarray:
        """Read ``nwords`` 32-bit words from a memory FIFO address.

        The caller must have started the ADC FPGA data transfer logic first
        (Data Transfer Control register). The transfer is split into requests
        of at most MAX_PACKETS_PER_REQUEST packets; a lost packet aborts the
        whole read with Sis3316Timeout so the caller can restart the transfer
        from a known memory address.
        """
        out = np.empty(nwords, dtype="<u4")
        if nwords == 0:
            return out
        view = out.view(np.uint8)
        per_request = WORDS_PER_PACKET * MAX_PACKETS_PER_REQUEST
        off = 3 if self.packet_id_mode else 2
        with self._lock:
            done = 0
            while done < nwords:
                n = min(per_request, nwords - done)
                req = self._header(CMD_FIFO_READ) + struct.pack("<HI", n - 1, addr)
                self._send(req)
                want = 4 * n
                got = 0
                pos = 4 * done
                while got < want:
                    ans = self._recv()
                    if ans[0] != CMD_FIFO_READ:
                        raise Sis3316ProtocolError(f"answer 0x{ans[0]:02x} to FIFO read")
                    self._check_pid(ans, req)
                    status = ans[off - 1]
                    if status & 0x70:
                        raise Sis3316ProtocolError(f"FIFO read: {_status_error(status)}")
                    payload = memoryview(ans)[off:]
                    take = min(len(payload), want - got)
                    view[pos + got:pos + got + take] = payload[:take]
                    got += take
                done += n
                self.bytes_read += want
        return out
