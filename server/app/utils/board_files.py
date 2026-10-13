"""
Board configuration files (conf/<name>_<id>.json): one lock and one writer.

Several request threads, the waveform switch and board setup all read, change
and rewrite these files. Every read-modify-write holds BOARD_FILE_LOCK, and
every write goes through write_json_atomic, so an edit is never lost to an
interleaved rewrite and a reader never sees half a file.
"""

import json
import os
import shutil
import tempfile
import threading

BOARD_FILE_LOCK = threading.RLock()


def write_json_atomic(path: str, data, indent: int = 4) -> None:
    """Write `data` as JSON to `path` atomically.

    Writes a temporary file in the same directory, fsyncs it, copies the
    original's permission mode, then renames it over the target (resolving a
    symlink, so the link itself is kept). The temporary file is removed if
    anything fails. Raises on failure.
    """
    target = os.path.realpath(path)
    directory = os.path.dirname(target) or '.'
    fd, tmp = tempfile.mkstemp(prefix='.' + os.path.basename(target) + '.', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, indent=indent)
            f.flush()
            os.fsync(f.fileno())
        if os.path.exists(target):
            shutil.copymode(target, tmp)
        else:
            os.chmod(tmp, 0o666 & ~_umask())
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _umask() -> int:
    mask = os.umask(0)
    os.umask(mask)
    return mask
