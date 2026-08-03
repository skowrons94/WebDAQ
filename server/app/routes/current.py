import os
import json
import numpy as np
import time

from datetime import datetime
from flask import Blueprint, jsonify, request
from ..utils.tetramm import tetram_controller, TetrAMMController
from ..utils.rbd9103 import rbd9103_controller, RBD9103Controller, list_serial_ports
from ..utils.graphite_current import GraphiteCurrentController
from ..services.daq_manager import get_daq_manager
from ..services.run_metadata_snapshot import sync_run_metadata_file
from ..services import graphite_reader
from ..services import run_data

from app import db
from ..models.run_metadata import RunMetadata
from ..utils.jwt_utils import jwt_required_custom

bp = Blueprint('current', __name__)

#TEST_FLAG = True
TEST_FLAG = os.getenv('TEST_FLAG', False)

# Initialize DAQ manager for accessing save flag
daq_mgr = get_daq_manager(test_flag=TEST_FLAG)

# Default settings
current_accumulating_run_number = 0
running = False

# The lifetime charge is persisted when it moves by at least this much (µC),
# rather than on every poll. At a typical 10 µA that is a write every few
# seconds; with no beam, none at all.
_TOTAL_SAVE_THRESHOLD_UC = 50.0
_last_saved_total = 0.0

# The modules that report a single current rather than a set of channels.
SINGLE_CHANNEL_MODULES = ("rbd9103", "graphite")

# What the current plot may ask for in one request. `bins` is what the chart
# actually draws (a plot cannot show more points than it has pixels); the raw
# limit only bounds how much of the controller's buffer is reduced into them.
MAX_HISTORY_BINS = 5000
MAX_RAW_HISTORY_POINTS = 200000

# Open conf/current.json if exists, create default if not
if os.path.exists("conf/current.json"):
    with open("conf/current.json") as f:
        settings = json.load(f)
else:
    settings = {
        "module_type": "tetramm",  # "tetramm", "rbd9103" or "graphite"
        "tetramm_ip": "169.254.145.10",
        "tetramm_port": 10001,
        "tetramm_charge_channel": 0,
        "rbd9103_port": "/dev/tty.usbserial-A50285BI",
        "rbd9103_baudrate": 57600,
        "rbd9103_high_speed": False,
        # Beam current read from a monitored Graphite metric instead of from a
        # picoammeter, for setups that take it from the accelerator. 'scale'
        # converts that metric into the µA everything else here works in.
        "graphite_metric": "",
        "graphite_metric_scale": 1.0,
        "graphite_poll_interval_s": 1.0,
        "total_accumulated": 0,
        # Carbon plaintext ingest, i.e. where samples are PUSHED. Reading
        # history back uses the render API configured in conf/stats.json.
        "graphite_host": "172.18.9.54",
        "graphite_port": 2003
    }
    os.makedirs("conf", exist_ok=True)
    with open("conf/current.json", "w") as f:
        json.dump(settings, f, indent=2)

# Initialize controllers
tetramm_ctrl = None
rbd9103_ctrl = None
graphite_ctrl = None
controller = None  # Active controller


def _build_graphite_controller() -> GraphiteCurrentController:
    """The Graphite-backed current module, configured from conf/current.json."""
    return GraphiteCurrentController(
        metric=settings.get("graphite_metric", ""),
        scale=settings.get("graphite_metric_scale", 1.0),
        poll_interval_s=settings.get("graphite_poll_interval_s", 1.0),
    )


def _is_single_channel() -> bool:
    """Whether the active module reports one current rather than four channels."""
    return settings.get("module_type", "tetramm") in SINGLE_CHANNEL_MODULES


# Initialize the selected module
module_type = settings.get("module_type", "tetramm")

if module_type == "graphite":
    # Deliberately not simulated under TEST_FLAG: this module needs no hardware
    # in the first place, so the useful thing in test mode is the real one
    # pointed at a real metric. With no metric configured it simply reports
    # nothing, which is the honest answer.
    graphite_ctrl = _build_graphite_controller()
    graphite_ctrl.set_total_accumulated_charge(settings.get("total_accumulated", 0))
    try:
        graphite_ctrl.initialize()
    except Exception as e:
        print(f"Warning: Could not start the Graphite current module at startup: {e}")
    controller = graphite_ctrl
elif TEST_FLAG:
    # No picoammeter in test mode. Substitute a simulated one so the current
    # readout, the accumulated charge and the per-run current.txt all behave —
    # otherwise a test-mode run produces no current data at all and the plots
    # and charge integration cannot be exercised.
    from ..utils.mock_current import MockCurrentController
    controller = MockCurrentController(single_channel=(module_type == "rbd9103"))
    controller.set_total_accumulated_charge(settings.get("total_accumulated", 0))
    controller.set_charge_channel(settings.get("tetramm_charge_channel", 0))
    controller.initialize()
    tetramm_ctrl = rbd9103_ctrl = controller   # module_type switching reuses these
elif module_type == "tetramm":
    tetramm_ctrl = tetram_controller(
        ip=settings["tetramm_ip"],
        port=settings["tetramm_port"],
        graphite_host=settings.get("graphite_host", "172.18.9.54"),
        graphite_port=settings.get("graphite_port", 2003)
    )
    tetramm_ctrl.set_total_accumulated_charge(settings.get("total_accumulated", 0))
    tetramm_ctrl.set_charge_channel(settings.get("tetramm_charge_channel", 0))
    # Initialize at startup
    try:
        tetramm_ctrl.initialize()
    except Exception as e:
        print(f"Warning: Could not initialize TetrAMM at startup: {e}")
    controller = tetramm_ctrl
elif module_type == "rbd9103":
    rbd9103_ctrl = rbd9103_controller
    rbd9103_ctrl.set_port(settings.get("rbd9103_port", "/dev/tty.usbserial-A50285BI"))
    rbd9103_ctrl.set_baudrate(settings.get("rbd9103_baudrate", 57600))
    rbd9103_ctrl.set_high_speed(settings.get("rbd9103_high_speed", False))
    rbd9103_ctrl.set_total_accumulated_charge(settings.get("total_accumulated", 0))
    # Initialize at startup
    try:
        rbd9103_ctrl.initialize()
    except Exception as e:
        print(f"Warning: Could not initialize RBD 9103 at startup: {e}")
    controller = rbd9103_ctrl


def _on_run_state_changed(running: bool) -> None:
    """
    Follow the run with the charge integration.

    The per-run charge is what the online analysis normalises to, so it must
    cover the run and nothing else. Hanging it off the DAQ's own run state —
    rather than off the client remembering to call /current/start and
    /current/stop — means a closed browser, a run stopped by the auto-restart,
    or a run that saves no data all leave the figure correct. The lifetime total
    is untouched: it keeps counting so it can show how much beam the target has
    seen, run or no run.
    """
    if controller is None:
        return
    try:
        if running:
            controller.reset_accumulated_charge()
            controller.set_accumulating(True)
        else:
            controller.set_accumulating(False)
            # Record the run's charge here rather than only in /current/stop:
            # the analysis needs it even when the browser that started the run
            # is gone by the time it ends.
            _persist_run_charge(current_accumulating_run_number,
                                controller.get_accumulated_charge())
    except Exception as e:
        print(f"Warning: could not update charge accumulation for run state {running}: {e}")


def _persist_run_charge(run_number: int, charge: float) -> None:
    """Store the run's accumulated charge in its metadata row, if it has one."""
    app = daq_mgr.flask_app
    if not run_number or app is None:
        return
    try:
        with app.app_context():
            run_metadata = RunMetadata.query.filter_by(run_number=int(run_number)).first()
            if run_metadata:
                run_metadata.accumulated_charge = charge
                db.session.commit()
                sync_run_metadata_file(run_metadata)
    except Exception as e:
        print(f"Warning: could not store accumulated charge for run {run_number}: {e}")


daq_mgr.add_run_state_listener(_on_run_state_changed)
# A server restarted mid-run must not sit there with the integration switched off.
if controller is not None and daq_mgr.is_running():
    controller.set_accumulating(True)


# Set ip and port
@bp.route('/current/set_ip_port/<ip>/<port>', methods=['GET'])
@jwt_required_custom
def set_ip_port(ip, port):
    global settings
    controller.set_ip(ip)
    controller.set_port(int(port))
    settings["tetramm_ip"] = ip
    settings["tetramm_port"] = port
    with open("conf/current.json", "w") as f:
        json.dump(settings, f)
    return jsonify({"message": "IP and port set"}), 200

# Get ip
@bp.route('/current/get_ip', methods=['GET'])
@jwt_required_custom
def get_ip_port():
    global settings
    return jsonify(settings["tetramm_ip"])

# Get port
@bp.route('/current/get_port', methods=['GET'])
@jwt_required_custom
def get_port():
    global settings
    return jsonify(settings["tetramm_port"])

# Connect to TetrAMM
@bp.route('/current/connect', methods=['GET'])
@jwt_required_custom
def connect():
    controller.initialize()
    if( controller.is_connected() ):
        return jsonify({"message": "Connected"}), 200
    return jsonify({"message": "Can not connect to TetrAMM"}), 400

# Check if connected
@bp.route('/current/is_connected', methods=['GET'])
@jwt_required_custom
def is_connected():
    if( controller.is_connected() ):
        return jsonify(True)
    return jsonify(False)

# Start acquisition thread
@bp.route('/current/start/<run_number>', methods=['GET'])
@jwt_required_custom
def start_acquisition(run_number):
    global running, current_accumulating_run_number
    if( not controller.is_connected() ):
        return jsonify({"message": "TetrAMM not connected"}), 200
    
    # Reset accumulated charge for this new run. Whether it *integrates* is not
    # decided here — that follows the DAQ run state (see _on_run_state_changed),
    # so charge is never counted before the run actually starts.
    controller.reset_accumulated_charge()
    current_accumulating_run_number = int(run_number)
    run = int(run_number)
    
    if( not controller.is_acquiring ):
        return jsonify({"message": "Can not start TetrAMM. Device not initialized"}), 400

    # Only save data if save data is enabled in DAQ settings
    if daq_mgr.get_save_data():
        if( not os.path.exists("./data/run{}".format(run)) ):
            os.makedirs("./data/run{}".format(run))
        controller.set_save_data(True, "./data/run{}/".format(run))
    else:
        controller.set_save_data(False, "./")
    running = True
    return jsonify({"message": "Acquisition started"}), 200

@bp.route('/current/stop', methods=['POST'])
@jwt_required_custom
def stop_acquisition():
    global running, current_accumulating_run_number
    if( not controller.is_connected() ):
        return jsonify({"message": "TetrAMM not connected"}), 200
    controller.set_save_data(False, "./")
    running = False
    run_number = current_accumulating_run_number
    run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
    if run_metadata:
        run_metadata.accumulated_charge = controller.get_accumulated_charge()
        db.session.commit()
        sync_run_metadata_file(run_metadata)
    return jsonify({"message": "Acquisition stopped"}), 200

@bp.route('/current/set/<settings>/<value>', methods=['GET'])
@jwt_required_custom
def set_setting(settings, value):
    if( not controller.is_connected() ):
        return jsonify({"message": "TetrAMM not connected"}), 200
    if( not controller.is_acquiring):
        return jsonify({"message": "Can not set setting. Device not initialized"}), 400
    controller.set_setting(settings, value)
    return jsonify({"message": "Setting set"}), 200

@bp.route('/current/get/<settings>', methods=['GET'])
@jwt_required_custom
def get_setting(settings):
    if( not controller.is_connected() ):
        return jsonify({"message": "TetrAMM not connected"}), 200
    if( not controller.is_acquiring):
        return jsonify({"message": "Can not get setting. Device not initialized"}), 400
    response = controller.get_setting(settings)
    return jsonify(response)

@bp.route('/current/reset', methods=['POST'])
@jwt_required_custom
def reset_device():
    global running
    controller.set_save_data(False, "./")
    controller.reset()
    running = False
    return jsonify({"message": "Device reset"}), 200

@bp.route('/current/data', methods=['GET'])
@jwt_required_custom
def get_data():
    if _is_single_channel():
        data = controller.get_data()
        if( data < 1e-9 ): data = 0
        return jsonify(data)
    else:
        all_data = controller.get_data()
        channel = str(controller.get_charge_channel()) if hasattr(controller, "get_charge_channel") else "0"
        data = all_data.get(channel, all_data["0"])
        if( data < 1e-9 ): data = 0
        return jsonify(data)

def _collimator(channel: str):
    """A collimator channel, or zero on the modules that have none.

    Only the TetrAMM has these extra inputs. Reporting zero rather than failing
    keeps a dashboard that polls them from filling the log with errors on a
    single-channel setup.
    """
    if _is_single_channel():
        return jsonify(0)
    data = controller.get_data()[channel]
    if( data < 1e-9 ): data = 0
    return jsonify(data)


@bp.route('/current/collimator/1', methods=['GET'])
@jwt_required_custom
def get_data_1():
    return _collimator("1")

@bp.route('/current/collimator/2', methods=['GET'])
@jwt_required_custom
def get_data_2():
    return _collimator("2")

@bp.route('/current/data_array', methods=['GET'])
@jwt_required_custom
def get_data_array():
    # Real thing
    if _is_single_channel():
        data = controller.get_data_array().tolist()
    else:
        data = controller.get_data_array()["0"].tolist()
    # For test: sample 100 points from normal distribution with mean 100 and std 10
    #data = np.random.normal(100, 10, 100)
    #data = data.tolist()
    return jsonify(data)


def _history_metric(channel: int) -> str:
    """The Graphite metric the active module publishes its current under.

    Every module pushes to Carbon as it samples, so Graphite is a complete
    record of a run even when it is far longer than the in-memory buffer.
    """
    module = settings.get("module_type", "tetramm")
    if module == "graphite":
        return str(settings.get("graphite_metric", "") or "")
    if module == "rbd9103":
        return "rbd9103.current"
    return f"tetram.ch{int(channel)}"


def _bin_samples(samples, start, end, bins):
    """
    Reduce timestamped samples to at most ``bins`` fixed-width bins.

    Returns ``([[time, mean, min, max], ...], bin_width_s)`` with empty bins
    dropped, so a window that outruns the data does not produce a line full of
    holes.

    Striding — keeping every Nth sample — is cheaper, but on a three-day run it
    reduces a 200 ms beam trip to a 4% chance of being drawn at all. Carrying
    the min and max alongside the mean means a trip stays visible however far
    the plot is zoomed out, at four numbers per bin instead of one.
    """
    if not samples:
        return [], None

    times = np.fromiter((s[0] for s in samples), dtype=float, count=len(samples))
    values = np.fromiter((s[1] for s in samples), dtype=float, count=len(samples))

    # One NaN would take its whole bin's mean, min and max with it, so a single
    # hole in the archive would draw as a gap several minutes wide.
    usable = np.isfinite(times) & np.isfinite(values)
    if not usable.all():
        times, values = times[usable], values[usable]
        if times.size == 0:
            return [], None

    span = float(end) - float(start)
    if span <= 0 or bins <= 0:
        return [[float(t), float(v), float(v), float(v)]
                for t, v in zip(times, values)], None

    width = span / bins
    index = np.clip(((times - float(start)) / width).astype(np.int64), 0, bins - 1)

    counts = np.bincount(index, minlength=bins)
    value_sums = np.bincount(index, weights=values, minlength=bins)
    time_sums = np.bincount(index, weights=times, minlength=bins)
    minima = np.full(bins, np.inf)
    maxima = np.full(bins, -np.inf)
    np.minimum.at(minima, index, values)
    np.maximum.at(maxima, index, values)

    filled = counts > 0
    if not filled.any():
        return [], width

    counts = counts[filled]
    rows = np.column_stack((
        time_sums[filled] / counts,     # the bin's own mean time, not its centre
        value_sums[filled] / counts,
        minima[filled],
        maxima[filled],
    ))
    return rows.tolist(), width


@bp.route('/current/history', methods=['GET'])
@jwt_required_custom
def get_current_history():
    """
    Timestamped beam-current history for the rolling and run-start plots.

    Pass ``bins`` to have the window reduced here rather than in the browser.
    That is what makes a three-day run viable: the response is a fixed number of
    points whatever the run's length, so the payload, the parse and the chart
    render all stop growing with it. Rows become ``[time, mean, min, max]``.

    Without ``bins`` the old ``[time, value]`` rows are returned unchanged, so
    existing clients (the mobile app) keep working.
    """
    try:
        max_points = max(100, min(20000, int(request.args.get('max_points', 20000))))
        bins_arg = request.args.get('bins')
        bins = (max(10, min(MAX_HISTORY_BINS, int(bins_arg)))
                if bins_arg is not None else None)
        since_arg = request.args.get('since')
        if since_arg is not None:
            since = float(since_arg)
        else:
            seconds = max(5.0, min(3600.0, float(request.args.get('seconds', 30))))
            since = time.time() - seconds
    except (TypeError, ValueError):
        return jsonify({"message": "Invalid history range"}), 400

    now = time.time()

    if controller is None:
        return jsonify({
            "samples": [],
            "sampled_at": now,
            "sample_interval_s": None,
            "channel": 0,
            "binned": bool(bins),
            "bin_width_s": None,
            "source": "none",
        })

    try:
        channel = int(controller.get_charge_channel())
    except (AttributeError, TypeError, ValueError):
        channel = 0

    # With binning the reduction happens below, so take the buffer whole rather
    # than letting get_history() stride it first and throw away the extremes.
    try:
        samples = controller.get_history(
            since=since,
            max_points=MAX_RAW_HISTORY_POINTS if bins else max_points)
    except Exception as e:
        print(f"Warning: could not read timestamped current history: {e}")
        return jsonify({"message": "Could not read current history"}), 500

    source = "controller-buffer"
    interval = getattr(controller, 'acquisition_interval', None)

    # The controller's buffer is large but finite — around 14 hours at the
    # TetrAMM's sampling rate. A dashboard opened deep into a long run needs the
    # missing prefix from somewhere else.
    tolerance = max(5.0, 3.0 * (interval or 1.0))
    buffer_misses_start = (
        since_arg is not None
        and daq_mgr.is_running()
        and (not samples or samples[0][0] - since > tolerance)
    )

    if buffer_misses_start:
        # Graphite first: it holds the whole run, it consolidates server-side,
        # and asking it for three days costs the same as asking for three
        # minutes. Reading current.txt instead means parsing every line of a
        # half-million-line file on a dashboard poll.
        metric = _history_metric(channel)
        scale = (float(settings.get("graphite_metric_scale", 1.0) or 1.0)
                 if settings.get("module_type") == "graphite" else 1.0)
        from_graphite = graphite_reader.fetch_series(
            metric,
            from_time=f'-{max(1, int(now - since))}s',
            until_time='now',
            max_points=bins or max_points,
            scale=scale)
        if from_graphite:
            samples = [point for point in from_graphite if point[0] >= since]
            source = "graphite"

    if buffer_misses_start and source != "graphite":
        # No Graphite (unreachable, or the metric is not archived): fall back to
        # the run's own log. Correct, just expensive.
        recorded = run_data.read_current(
            daq_mgr.get_run_number(), max_points=MAX_RAW_HISTORY_POINTS if bins else max_points)
        if recorded.get("available") and recorded.get("start_time"):
            try:
                recorded_start = datetime.fromisoformat(
                    recorded["start_time"]).timestamp()
                from_file = []
                for row in recorded.get("samples", []):
                    if len(row) < 2:
                        continue
                    timestamp = recorded_start + float(row[0])
                    if timestamp < since:
                        continue
                    value_index = min(channel + 1, len(row) - 1)
                    from_file.append([timestamp, float(row[value_index])])
                if from_file:
                    samples = from_file
                    source = "run-log"
            except (TypeError, ValueError):
                pass

    bin_width = None
    if bins and samples:
        # Bin across the data's own extent, not the requested window. A window
        # that reaches back further than the data — a run whose log starts late,
        # a buffer that has only just filled — would otherwise put every sample
        # in the first bin and draw a single point.
        samples, bin_width = _bin_samples(samples, samples[0][0], samples[-1][0], bins)

    return jsonify({
        "samples": samples,
        "sampled_at": now,
        "sample_interval_s": interval,
        "channel": channel,
        "binned": bool(bins),
        "bin_width_s": bin_width,
        "source": source,
    })

@bp.route('/current/accumulated', methods=['GET'])
@jwt_required_custom
def get_accumulated():
    if( not controller.is_connected() ):
        return jsonify(controller.get_accumulated_charge())
    
    # If thread dead, reset controller
    if( not controller.check_thread() ):
        controller.reset( )
    
    # Update accumulated charge in TetrAMM controller
    accumulated_charge = controller.get_accumulated_charge()
    return jsonify(accumulated_charge)

@bp.route('/current/total_accumulated', methods=['GET'])
@jwt_required_custom
def get_total_accumulated():
    global settings, _last_saved_total
    settings["total_accumulated"] = controller.get_total_accumulated_charge()

    # In test mode the charge is simulated. Writing it to conf/current.json
    # would leave a real setup carrying a lifetime total that no beam ever
    # produced, so the value is reported but not persisted.
    if not TEST_FLAG:
        # The dashboard polls this once a second per client. Rewriting the
        # configuration file that often wears the disk for nothing and risks a
        # truncated file if the server dies mid-write, so only write when the
        # number has actually moved by something worth recording.
        total = settings["total_accumulated"]
        if abs(total - _last_saved_total) >= _TOTAL_SAVE_THRESHOLD_UC:
            try:
                with open("conf/current.json", "w") as f:
                    json.dump(settings, f)
                _last_saved_total = total
            except Exception as e:
                print(f"Warning: could not save the accumulated charge: {e}")

    return jsonify(settings["total_accumulated"])

# Reset total accumulated
@bp.route('/current/reset_total_accumulated', methods=['POST'])
@jwt_required_custom
def reset_total_accumulated():
    global settings, _last_saved_total
    settings["total_accumulated"] = 0
    controller.set_total_accumulated_charge(0)

    # Persist immediately. This used to depend on the next poll writing the
    # file, so a reset followed by a restart brought the old total back — and
    # now that polls only write when the value has moved, nothing would have
    # written it at all.
    _last_saved_total = 0.0
    try:
        with open("conf/current.json", "w") as f:
            json.dump(settings, f)
    except Exception as e:
        print(f"Warning: could not save the reset accumulated charge: {e}")

    return jsonify({"message": "Total accumulated reset"}), 200

# Get current module type
@bp.route('/current/module_type', methods=['GET'])
@jwt_required_custom
def get_module_type():
    global settings
    return jsonify({"module_type": settings.get("module_type", "tetramm")})

# Set module type (switch between tetramm and rbd9103)
@bp.route('/current/module_type', methods=['POST'])
@jwt_required_custom
def set_module_type():
    global settings, controller, tetramm_ctrl, rbd9103_ctrl, graphite_ctrl, running

    data = request.get_json()
    new_module_type = data.get('module_type')

    if new_module_type not in ['tetramm', 'rbd9103', 'graphite']:
        return jsonify({"error": "Invalid module type. Must be 'tetramm', 'rbd9103' or 'graphite'"}), 400

    if new_module_type == settings.get("module_type"):
        return jsonify({"message": "Module type already set"}), 200

    # Stop current controller if running
    if controller:
        try:
            if running:
                controller.set_save_data(False, "./")
                running = False
            if controller.is_acquiring:
                controller.stop_acquisition()
            controller.disconnect()
        except Exception as e:
            print(f"Error stopping current controller: {e}")

    # Save total accumulated charge before switching
    if controller:
        settings["total_accumulated"] = controller.get_total_accumulated_charge()

    # Update settings
    settings["module_type"] = new_module_type
    with open("conf/current.json", "w") as f:
        json.dump(settings, f, indent=2)

    # Initialize new controller
    try:
        if new_module_type == "graphite":
            # Needs no hardware, so it is the real module in test mode too.
            if not graphite_ctrl:
                graphite_ctrl = _build_graphite_controller()
            else:
                graphite_ctrl.configure(
                    metric=settings.get("graphite_metric", ""),
                    scale=settings.get("graphite_metric_scale", 1.0),
                    poll_interval_s=settings.get("graphite_poll_interval_s", 1.0))
            graphite_ctrl.set_total_accumulated_charge(settings.get("total_accumulated", 0))
            graphite_ctrl.initialize()
            controller = graphite_ctrl
            controller.set_accumulating(daq_mgr.is_running())
            return jsonify({"message": "Switched to the monitored Graphite metric"}), 200

        if TEST_FLAG:
            # Rebuild the simulated module in the shape of the chosen device:
            # the RBD 9103 reports a single current, the TetrAMM four channels.
            from ..utils.mock_current import MockCurrentController
            if controller:
                controller.disconnect()
            controller = MockCurrentController(single_channel=(new_module_type == "rbd9103"))
            controller.set_total_accumulated_charge(settings.get("total_accumulated", 0))
            controller.set_charge_channel(settings.get("tetramm_charge_channel", 0))
            controller.initialize()
            tetramm_ctrl = rbd9103_ctrl = controller
            controller.set_accumulating(daq_mgr.is_running())
            return jsonify({"message": f"Switched to simulated {new_module_type}"}), 200

        if new_module_type == "tetramm":
            if not tetramm_ctrl:
                tetramm_ctrl = TetrAMMController(
                    ip=settings.get("tetramm_ip", "169.254.145.10"),
                    port=settings.get("tetramm_port", 10001)
                )
            tetramm_ctrl.set_total_accumulated_charge(settings.get("total_accumulated", 0))
            tetramm_ctrl.set_charge_channel(settings.get("tetramm_charge_channel", 0))
            tetramm_ctrl.initialize()
            controller = tetramm_ctrl
        else:  # rbd9103
            if not rbd9103_ctrl:
                rbd9103_ctrl = RBD9103Controller(
                    port=settings.get("rbd9103_port", "/dev/tty.usbserial-A50285BI"),
                    baudrate=settings.get("rbd9103_baudrate", 57600),
                    high_speed=settings.get("rbd9103_high_speed", False)
                )
            rbd9103_ctrl.set_total_accumulated_charge(settings.get("total_accumulated", 0))
            rbd9103_ctrl.initialize()
            controller = rbd9103_ctrl

        # The new module takes over mid-run as the old one left off.
        controller.set_accumulating(daq_mgr.is_running())

        return jsonify({"message": f"Switched to {new_module_type}"}), 200

    except Exception as e:
        return jsonify({"error": f"Failed to initialize {new_module_type}: {str(e)}"}), 500

# Get module-specific settings
@bp.route('/current/module_settings', methods=['GET'])
@jwt_required_custom
def get_module_settings():
    global settings

    module_type = settings.get("module_type", "tetramm")

    # Device parameters, from the file first and the live controller on top.
    # The file is what the device was configured with and is always there; the
    # controller only has them once it has initialised (and the simulated module
    # has none at all), so reading the controller alone reports "nothing
    # configured" for a device that is perfectly well configured.
    if module_type == "graphite":
        # No device file: the module IS its configuration.
        return jsonify({
            "module_type": "graphite",
            "metric": settings.get("graphite_metric", ""),
            "scale": settings.get("graphite_metric_scale", 1.0),
            "poll_interval_s": settings.get("graphite_poll_interval_s", 1.0),
            "settings": getattr(controller, 'settings', {}) if controller else {},
        })

    settings_file = 'conf/tetram.json' if module_type == "tetramm" else 'conf/rbd9103.json'
    controller_settings = {}
    try:
        if os.path.exists(settings_file):
            with open(settings_file) as f:
                stored = json.load(f)
            if isinstance(stored, dict):
                controller_settings.update(stored)
    except Exception as e:
        print(f"Error reading {settings_file}: {e}")

    if controller:
        try:
            live = getattr(controller, 'settings', None)
            if isinstance(live, dict):
                controller_settings.update(live)
        except Exception as e:
            print(f"Error accessing controller settings: {e}")

    if module_type == "tetramm":
        return jsonify({
            "module_type": "tetramm",
            "ip": settings.get("tetramm_ip", "169.254.145.10"),
            "port": settings.get("tetramm_port", 10001),
            "charge_channel": settings.get("tetramm_charge_channel", 0),
            "settings": controller_settings
        })
    else:  # rbd9103
        return jsonify({
            "module_type": "rbd9103",
            "port": settings.get("rbd9103_port", "/dev/tty.usbserial-A50285BI"),
            "baudrate": settings.get("rbd9103_baudrate", 57600),
            "high_speed": settings.get("rbd9103_high_speed", False),
            "settings": controller_settings
        })

# Update module-specific settings
@bp.route('/current/module_settings', methods=['POST'])
@jwt_required_custom
def update_module_settings():
    global settings, controller

    data = request.get_json()
    module_type = settings.get("module_type", "tetramm")

    try:
        if module_type == "graphite":
            if "metric" in data:
                settings["graphite_metric"] = str(data["metric"] or "").strip()
            if "scale" in data:
                settings["graphite_metric_scale"] = float(data["scale"])
            if "poll_interval_s" in data:
                settings["graphite_poll_interval_s"] = max(0.2, float(data["poll_interval_s"]))

            # Retarget the live module rather than making the operator restart
            # it: the charge already integrated is kept either way.
            if controller and hasattr(controller, "configure"):
                controller.configure(
                    metric=settings.get("graphite_metric", ""),
                    scale=settings.get("graphite_metric_scale", 1.0),
                    poll_interval_s=settings.get("graphite_poll_interval_s", 1.0))

        elif module_type == "tetramm":
            # Update TetrAMM settings
            if "ip" in data:
                settings["tetramm_ip"] = data["ip"]
                if controller:
                    controller.set_ip(data["ip"])

            if "port" in data:
                settings["tetramm_port"] = int(data["port"])
                if controller:
                    controller.set_port(int(data["port"]))

            # Charge channel is a software-side selection (not a device command),
            # so handle it separately from device_settings.
            if "charge_channel" in data:
                settings["tetramm_charge_channel"] = int(data["charge_channel"])
                if controller and hasattr(controller, "set_charge_channel"):
                    controller.set_charge_channel(int(data["charge_channel"]))

            # Update device-specific settings (CHN, RNG, ASCII, etc.)
            if "device_settings" in data:
                for key, value in data["device_settings"].items():
                    if controller:
                        # Always update local settings first (for persistence)
                        if hasattr(controller, 'settings') and key in controller.settings:
                            controller.settings[key] = value
                            
                        # Try to send to device if we have a socket connection
                        device_updated = False
                        try:
                            if hasattr(controller, 'socket') and controller.socket:
                                # Send command to device and let set_setting handle the file save
                                response = controller._send_command(f'{key}:{value}')
                                device_updated = True
                                print(f"TetrAMM setting sent to device: {key}={value}")
                        except Exception as e:
                            print(f"Failed to send setting to device: {e}")
                            
                        # Always save to file (whether device update succeeded or not)
                        try:
                            controller.write_settings()  # Save to tetram.json
                            if not device_updated:
                                print(f"TetrAMM disconnected, saved setting {key}={value} to file only")
                        except Exception as e:
                            print(f"Failed to save settings to file: {e}")

        else:  # rbd9103
            # Update RBD 9103 settings. Port / baudrate / high_speed all require
            # closing the existing serial connection and reopening with the new
            # parameters, so collect the fact that we changed any of them and
            # call reset() once at the end.
            needs_reconnect = False

            if "port" in data:
                settings["rbd9103_port"] = data["port"]
                if controller:
                    controller.set_port(data["port"])
                    needs_reconnect = True

            if "baudrate" in data:
                settings["rbd9103_baudrate"] = int(data["baudrate"])
                if controller:
                    controller.set_baudrate(int(data["baudrate"]))
                    needs_reconnect = True

            if "high_speed" in data:
                settings["rbd9103_high_speed"] = bool(data["high_speed"])
                if controller:
                    controller.set_high_speed(bool(data["high_speed"]))
                    needs_reconnect = True

            if needs_reconnect and controller:
                try:
                    controller.reset()
                except Exception as e:
                    print(f"Failed to reset RBD 9103 after settings change: {e}")

            # Update device-specific settings (range, filter, bias, etc.)
            if "device_settings" in data:
                for key, value in data["device_settings"].items():
                    if controller and controller.is_connected():
                        if key == "range":
                            controller.set_range(value)
                        elif key == "filter":
                            controller.set_filter(value)
                        elif key == "input_mode":
                            controller.set_input_mode(value)
                        elif key == "bias":
                            controller.set_bias(value)

        # Save settings to file
        with open("conf/current.json", "w") as f:
            json.dump(settings, f, indent=2)

        return jsonify({"message": "Settings updated successfully"}), 200

    except Exception as e:
        return jsonify({"error": f"Failed to update settings: {str(e)}"}), 500

# Get graphite server configuration
@bp.route('/current/graphite_config', methods=['GET'])
@jwt_required_custom
def get_graphite_config():
    global settings
    return jsonify({
        "graphite_host": settings.get("graphite_host", "172.18.9.54"),
        "graphite_port": settings.get("graphite_port", 2003)
    })

# Set graphite server configuration
@bp.route('/current/graphite_config', methods=['POST'])
@jwt_required_custom
def set_graphite_config():
    global settings, controller

    data = request.get_json()
    graphite_host = data.get('graphite_host')
    graphite_port = data.get('graphite_port')

    if not graphite_host or not graphite_port:
        return jsonify({"error": "Missing graphite_host or graphite_port"}), 400

    try:
        # Update settings
        settings["graphite_host"] = graphite_host
        settings["graphite_port"] = int(graphite_port)

        # Save to file
        with open("conf/current.json", "w") as f:
            json.dump(settings, f, indent=2)

        # Update controller if it's tetramm
        if controller and hasattr(controller, 'graphite_host'):
            controller.graphite_host = graphite_host
            controller.graphite_port = int(graphite_port)

        return jsonify({"message": "Graphite configuration updated"}), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Get comprehensive status including module type
@bp.route('/current/serial_ports', methods=['GET'])
@jwt_required_custom
def get_serial_ports():
    """List serial ports detected on the host so the UI can offer a pick-list."""
    return jsonify({"ports": list_serial_ports()})


@bp.route('/current/status', methods=['GET'])
@jwt_required_custom
def get_status():
    global settings, controller, running

    if not controller:
        return jsonify({
            "module_type": settings.get("module_type", "tetramm"),
            "connected": False,
            "running": False,
            "acquiring": False,
            "thread_alive": False
        })

    try:
        # Get basic status without calling potentially hanging methods
        module_type = settings.get("module_type", "tetramm")
        
        # Safely check basic controller state without socket operations
        basic_status = {
            "module_type": module_type,
            "running": running,
            "acquiring": getattr(controller, 'is_acquiring', False),
            "thread_alive": False,
            "connected": False,
            "settings": getattr(controller, 'settings', {})
        }
        
        # Safely check thread status
        try:
            if hasattr(controller, 'acquisition_thread') and controller.acquisition_thread:
                basic_status["thread_alive"] = controller.acquisition_thread.is_alive()
        except:
            pass
            
        # Try to get connection status with timeout protection
        try:
            # For RBD 9103, defer to is_connected() which also checks that the
            # device is producing valid samples — a bare open serial port can
            # mean nothing (wrong /dev/ttyUSB, silent device, etc).
            if module_type == "tetramm":
                # A live socket is the quick answer, but a controller without a
                # 'socket' attribute is not therefore disconnected — asking it
                # directly is what /current/is_connected does, and the two
                # endpoints disagreeing about the same device is worse than
                # either answer.
                if getattr(controller, 'socket', None):
                    basic_status["connected"] = True
                else:
                    basic_status["connected"] = bool(controller.is_connected())
            elif module_type == "graphite":
                # "Connected" here means the metric is arriving, not that the
                # server answers — a reachable Graphite with a dead metric is
                # not a working current readout.
                basic_status["connected"] = controller.is_connected()
                basic_status["metric"] = getattr(controller, 'metric', '')
                basic_status["latest_measurement"] = float(controller.get_data())
            elif module_type == "rbd9103":
                basic_status["connected"] = controller.is_connected()
                # Report whether the configured serial device file exists at all,
                # so the UI can distinguish "unplugged/missing port" from
                # "present but not yet producing samples".
                if hasattr(controller, 'port_exists'):
                    basic_status["port_exists"] = controller.port_exists()
                    basic_status["port"] = getattr(controller, 'port_name', None)
        except:
            basic_status["connected"] = False

        return jsonify(basic_status)
        
    except Exception as e:
        print(f"Error getting controller status: {e}")
        # Return default status if controller fails
        return jsonify({
            "module_type": settings.get("module_type", "tetramm"),
            "connected": False,
            "running": False,
            "acquiring": False,
            "thread_alive": False,
            "error": str(e)
        })
