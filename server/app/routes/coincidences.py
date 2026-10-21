# app/routes/coincidences.py
"""
Online coincidences: the gates the operator defines, and what they produce.

The configuration is kept in conf/coincidences.json and may be changed during
a run: the builder then starts its gates over with the new definition. The
spectra come back as ROOT JSON, like every other histogram, so the frontend
draws them with the same JSROOT component.
"""

import os

import numpy as np
from flask import Blueprint, jsonify, request

from app.utils.jwt_utils import jwt_required_custom

from ..services.coincidences import MATRIX_BINS, get_coincidence_builder
from ..services.spy_manager import get_spy_manager

TEST_FLAG = os.getenv('TEST_FLAG', False)

bp = Blueprint('coincidences', __name__)


def _builder():
    return get_coincidence_builder()


def _root():
    try:
        import ROOT
        ROOT.gErrorIgnoreLevel = ROOT.kError
        return ROOT
    except ImportError:
        return None


def _th1(name, title, arr, xmin, xmax, xtitle):
    ROOT = _root()
    hist = ROOT.TH1F(name, title, len(arr), xmin, xmax)
    buf = np.zeros(len(arr) + 2, dtype=np.float64)
    buf[1:-1] = arr
    hist.SetContent(np.ascontiguousarray(buf))
    hist.SetEntries(float(np.sum(arr)))
    hist.GetXaxis().SetTitle(xtitle)
    hist.SetStats(0)
    return hist


def _json(hist):
    data = get_spy_manager(test_flag=TEST_FLAG).convert_histogram_to_json(hist)
    return data if data else ("", 204)


def _empty(reason):
    ROOT = _root()
    hist = ROOT.TH1F("no_data", reason, 100, 0, 100)
    hist.SetStats(0)
    return _json(hist)


@bp.route('/coincidences/config', methods=['GET'])
@jwt_required_custom
def get_config():
    return jsonify(_builder().get_config()), 200


@bp.route('/coincidences/config', methods=['PUT'])
@jwt_required_custom
def put_config():
    payload = request.get_json(silent=True)
    try:
        return jsonify(_builder().set_config(payload)), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 400


@bp.route('/coincidences/status', methods=['GET'])
@jwt_required_custom
def get_status():
    return jsonify(_builder().status()), 200


@bp.route('/coincidences/reset', methods=['POST'])
@jwt_required_custom
def reset():
    _builder().reset()
    return jsonify({'ok': True}), 200


@bp.route('/coincidences/<gate_id>/align', methods=['POST'])
@jwt_required_custom
def align(gate_id):
    try:
        return jsonify({'offsets_ns': _builder().align(gate_id)}), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 400


@bp.route('/coincidences/<gate_id>/spectrum/<board_id>/<int:channel>', methods=['GET'])
@jwt_required_custom
def spectrum(gate_id, board_id, channel):
    """The gated (or vetoed) energy spectrum of one channel of the gate, with
    the channel's calibration and the dashboard's rebinning, like its singles."""
    if _root() is None:
        return jsonify({'error': 'ROOT is not available'}), 503
    arr = _builder().spectrum(gate_id, f"{board_id}:{channel}")
    if arr is None:
        return _empty("Not part of the gates of this run")
    hist = _th1(f"coinc_{gate_id}_{board_id}_{channel}", "Gated spectrum", arr, 0, len(arr), "")
    spy = get_spy_manager(test_flag=TEST_FLAG)
    from ..services.daq_manager import get_daq_manager
    from ..services.spy_manager import calibrate_x_axis
    boards = get_daq_manager().get_boards()
    name = next((str(b['name']) for b in boards if str(b['id']) == str(board_id)), None)
    if name:
        offset, slope = spy._read_calibration(name, str(board_id), int(channel))
        if (offset, slope) != (0.0, 1.0):
            calibrate_x_axis(hist, offset, slope)
    if spy.rebin_factor > 1:
        hist.Rebin(spy.rebin_factor)
    return _json(hist)


@bp.route('/coincidences/<gate_id>/dt/<board_id>/<channel>/<partner>', methods=['GET'])
@jwt_required_custom
def dt(gate_id, board_id, channel, partner):
    """Δt = t(partner) - t(channel). `partner` is 'board:channel', or '*' for
    all partners together; channel '*' sums the gate's channels too."""
    if _root() is None:
        return jsonify({'error': 'ROOT is not available'}), 503
    key = "*" if channel == "*" else f"{board_id}:{channel}"
    got = _builder().dt(gate_id, key, partner)
    if got is None:
        return _empty("No Δt spectrum for this pair")
    arr, rng = got
    return _json(_th1(f"dt_{gate_id}", "Δt to partner", arr, -rng, rng, "t(partner) - t(channel) [ns]"))


@bp.route('/coincidences/<gate_id>/matrix', methods=['GET'])
@jwt_required_custom
def matrix(gate_id):
    ROOT = _root()
    if ROOT is None:
        return jsonify({'error': 'ROOT is not available'}), 503
    got = _builder().matrix(gate_id)
    if got is None:
        return _empty("The matrix is off for this gate")
    m, (bx, by) = got
    hist = ROOT.TH2F(f"mat_{gate_id}", "Energy vs partner energy",
                     MATRIX_BINS, 0, bx, MATRIX_BINS, 0, by)
    content = np.zeros((MATRIX_BINS + 2, MATRIX_BINS + 2), dtype=np.float64)
    content[1:-1, 1:-1] = m.T
    hist.SetContent(np.ascontiguousarray(content).ravel())
    hist.SetEntries(float(m.sum()))
    hist.SetStats(0)
    return _json(hist)
