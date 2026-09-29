"""
The daisy chain, as caendaq actually starts it.

A synchronised run works like this (Daq.cpp: every synchronised board is armed,
then the master fires one software trigger):

    board 0 (MASTER)         board 1              board 2
    armed, first trigger     armed                armed
    SendSWTrigger() ──TRG-OUT──> TRG-IN ──TRG-OUT──> TRG-IN

The master is started by its *own* software trigger, which is why its start mode
has to be "first trigger": that mode starts the run on the first trigger the board
sees, and a software trigger is one. The same pulse leaves TRG-OUT — if bit 31
routes it there — and walks down the cable.

What each board needs therefore depends on where it sits, and the differences are
what this module reports:

* the **master** needs its software trigger on TRG-OUT (0x8110 bit 31). It does
  *not* need TRG-IN -> TRG-OUT: no trigger arrives on its TRG-IN, it makes its own.
* a **board in the middle** needs TRG-IN -> TRG-OUT (bit 30) to pass the pulse on.
* the **last board** needs nothing on its TRG-OUT: the chain ends there.

Getting this wrong is expensive and silent — the run starts, one board never
sees a trigger, and the data is short — so these checks are reported next to the
switches that cause them.
"""

from typing import Any, Dict, List

from . import caen_acquisition as acq

# Start modes (Acquisition Control 0x8100 bits[1:0]) that leave a board armed,
# waiting for something outside itself. Anything but SW controlled.
_ARMED_MODES = (acq.START_MODE_SIN_GPI, acq.START_MODE_FIRST_TRIG, acq.START_MODE_LVDS)

# What TRG-OUT has to carry (0x811C bits[17:16]) for the chain to work.
_TRG_OUT_TRIGGER = 0


def board_entry(board: Dict[str, Any]) -> Dict[str, Any]:
    """Everything the synchronisation panel shows for one board."""
    control = acq.acquisition_control_of(board)
    fpio = acq.front_panel_io_of(board)
    trg_out = acq.trg_out_mask_of(board)
    mode = control & 0x3
    return {
        'board_id': board['id'],
        'name': board['name'],
        'start_mode': mode,
        'start_mode_name': acq.START_MODE_NAMES.get(mode, 'unknown'),
        'synchronised': mode != acq.START_MODE_SW,
        # PLL reference clock (0x8100 bit[6]): 0 = internal 50 MHz oscillator,
        # 1 = external CLK-IN. Boards sharing a clock stay phase-aligned for the
        # whole run, which synchronising the START alone does not give.
        'clock_source': (control >> 6) & 0x1,
        'acquisition_control': control,
        # 0x811C[17:16]: 0 = Trigger (per 0x8110), 1 = motherboard probe,
        # 2 = channel probe, 3 = S-IN/GPI propagation.
        'trg_out_mode': (fpio >> 16) & 0x3,
        'front_panel_io_control': fpio,
        # 0x8110[31] software trigger -> TRG-OUT (how the master starts the chain).
        'sw_trigger_to_trg_out': (trg_out >> 31) & 0x1,
        # 0x8110[30] external TRG-IN -> TRG-OUT (how a board passes the start on).
        'ext_trigger_to_trg_out': (trg_out >> 30) & 0x1,
        'trg_out_mask': trg_out,
        'role': 'independent',      # replaced below for the chained boards
        'problems': [],
    }


def _register_ids() -> Dict[str, Any]:
    """WebDAQ board id -> the board's own register id, while a run is configured.

    caendaq picks the master by the board's REGISTER id (Daq::masterIndex reads
    GetBoardRegID), while WebDAQ's configured id is the link/node number. They
    usually agree, and when they do not, naming the wrong master would demand the
    trigger routing from a board that does not start the chain — the silent,
    expensive failure this module exists to prevent. The register ids are only
    knowable while the boards are open, so this is best-effort.
    """
    try:
        from .caen_acquisition import get_caen_acquisition
        info = get_caen_acquisition().board_info_all()
    except Exception:
        return {}
    out = {}
    for board in info or []:
        reg = board.get('board_reg_id')
        if reg is not None:
            out[str(board.get('board_id'))] = reg
    return out


def chain_status(boards: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Describe the boards' synchronisation, and what would stop it working.

    The chain is taken to start at the master and continue through the other
    synchronised boards in configuration order, which is the order caendaq itself
    uses (Daq::masterIndex, ClockSync).
    """
    chain = [board_entry(board) for board in boards]
    synced = [entry for entry in chain if entry['synchronised']]

    if not synced:
        return {'mode': 'independent', 'chain': chain, 'synchronised_count': 0,
                'applicable': len(boards) > 1, 'register': 'reg_8100',
                'master_board_id': None, 'master_from': 'none'}

    # The master fires the software trigger: register id 0 by CAEN convention,
    # else the first synchronised board. Mirrors Daq::masterIndex().
    register_ids = _register_ids()
    master, master_from = None, 'configured id'
    if register_ids:
        master = next((e for e in synced
                       if register_ids.get(str(e['board_id'])) == 0), None)
        if master is not None:
            master_from = 'board register id'
    if master is None:
        master = next((e for e in synced if str(e['board_id']) == '0'), synced[0])
    for entry in chain:
        entry['board_reg_id'] = register_ids.get(str(entry['board_id']))
    for entry in synced:
        entry['role'] = 'master' if entry is master else 'slave'

    # Cable order: the pulse starts at the master and walks the rest.
    order = [master] + [e for e in synced if e is not master]
    last = order[-1]

    for position, entry in enumerate(order):
        problems = []
        is_master = entry is master
        is_last = entry is last

        if is_master and entry['start_mode'] != acq.START_MODE_FIRST_TRIG:
            # The master is started by its own software trigger, and only
            # "first trigger" mode treats that as the start of the run.
            problems.append(
                f"the master is in {entry['start_mode_name']} mode, so the software "
                "trigger that starts the chain will not start this board — use "
                "'On first trigger'")

        # TRG-OUT only matters while there is a board further down the cable.
        if not is_last and entry['trg_out_mode'] != _TRG_OUT_TRIGGER:
            problems.append(
                "TRG-OUT is not set to carry the trigger, so nothing reaches the "
                "next board")

        if is_master:
            if not is_last and not entry['sw_trigger_to_trg_out']:
                problems.append(
                    "the software trigger is not routed to TRG-OUT, so the boards "
                    "after this one will never start")
        elif not is_last and not entry['ext_trigger_to_trg_out']:
            # Only a board that has to forward a trigger it received needs this.
            problems.append(
                "TRG-IN is not routed to TRG-OUT, so boards after this one will not start")

        entry['problems'] = problems
        entry['chain_position'] = position
        # What this board needs, so the UI can mark the switches that matter for
        # it instead of demanding all of them everywhere.
        entry['needs'] = {
            'start_mode_first_trigger': is_master,
            'trg_out_trigger': not is_last,
            'sw_trigger_to_trg_out': is_master and not is_last,
            'ext_trigger_to_trg_out': (not is_master) and (not is_last),
        }

    return {
        'mode': 'daisy-chain',
        'chain': chain,
        'synchronised_count': len(synced),
        'applicable': len(boards) > 1,
        'register': 'reg_8100',
        'master_board_id': master['board_id'],
        # Whether the master is known from the hardware or assumed from the
        # configuration, so the panel can say which it is.
        'master_from': master_from,
    }
