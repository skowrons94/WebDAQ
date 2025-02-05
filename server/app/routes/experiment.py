# app/routes/experiment.py
import os
import gc
import csv
import json
import time as time_lib

from ROOT import TBufferJSON, TH1F

from datetime import datetime

from flask import Blueprint, request, jsonify, send_from_directory
from app import db
from app.models.run_metadata import RunMetadata
from app.utils.jwt_utils import jwt_required_custom, get_current_user

from app.services import xdaq
from app.services.spy import ru_spy

import threading

XDAQ_FLAG = True

bp = Blueprint('experiment', __name__)

os.system( "killall RUSpy" )
os.system( "killall BUSpy" )
os.system( "docker stop xdaq" )

#start_thread = False
#t_crash = None

def update_project( daq_state ):

    # Save as JSON
    with open('conf/settings.json', 'w') as f:
        json.dump(daq_state, f, indent=4)

    topology.write_ruconf(daq_state)

# Functio to get histo index and board dpp
def get_info( board_id, channel, boards ):
    idx = 0
    for board in boards:
        if int(board['id']) < int(board_id):
            idx += board['chan']
    idx += int(channel)
    dpp = boards[int(board_id)]['dpp']
    return idx, dpp

def check_project( ):
    # Check if directory exists, if not create it
    if not os.path.exists('conf'): 
        os.makedirs('conf')
    # Check if directory exists, if not create it
    if not os.path.exists('calib'): 
        os.makedirs('calib')
    # Check if exists, if not create it
    if os.path.exists('conf/settings.json'):
        with open('conf/settings.json', 'r') as f: 
            daq_state = json.load(f)
    else:
        # Variables to store the current DAQ system state and CAEN boards
        daq_state = {
            'running': False,
            'start_time': 0,
            'run': 0,
            'save': False,
            'limit_size': False,
            'file_size_limit': 0,
            'boards': []
        }
        with open('conf/settings.json', 'w') as f: 
            json.dump(daq_state, f)
    return daq_state

daq_state = check_project( )

topology = xdaq.topology("conf/topology.xml")
topology.load_topology( )
topology.display()

r_spy = ru_spy( )

if( XDAQ_FLAG ):
    directory = os.path.dirname(os.path.realpath("./server"))
    container = xdaq.container(directory)
    try:
        status = topology.get_daq_status( )
    except:
        status = "Unknown"
    if( status == "Running" ):
        r_spy.start(daq_state)
    else:
        container.initialize()
        print( "Container started...")
        topology.configure_pt( )
        print( "PT configured...")
        topology.enable_pt( )
        print( "PT enabled...")

update_project(daq_state)

@bp.route("/experiment/start_run", methods=['POST'])
@jwt_required_custom
def start_run( ):
    global daq_state, t_crash, start_thread

    run = daq_state['run']
    save = daq_state['save']
    running = daq_state['running']
    limit_size = daq_state['limit_size']
    file_size_limit = daq_state['file_size_limit']

    # If the DAQ is already running, do nothing
    if running:
        return jsonify({'message': 'DAQ is already running !'}), 404
    
    # If there are no CAEN boards, do nothing
    if len(daq_state['boards']) == 0:
        return jsonify({'message': 'No CAEN boards found !'}), 404

    # Check if directory exists before starting DAQ
    directory = f"data/"
    if not os.path.exists(directory):
        os.makedirs(directory)
    directory = f"data/run{run}/"
    if not os.path.exists(directory):
        os.makedirs(directory)

    # Copy the JSON configuration files to the run directory
    for board in daq_state['boards']:
        conf_file = f"conf/{board['name']}_{board['id']}.json"
        os.system(f"cp {conf_file} data/run{run}/")

    # Start the XDAQ
    if( XDAQ_FLAG ):
        topology.set_cycle_counter(0)
        if( limit_size ): topology.set_file_size_limit(file_size_limit)
        else: topology.set_file_size_limit(0)
        topology.set_run_number(run)
        topology.set_enable_files(save)
        topology.set_file_paths(f"/home/xdaq/project/data/run{run}/")
        topology.configure( )
        topology.start( )

    daq_state['running'] = True

    # Run the Spy to  save the histograms to txt file in run directory
    # Example: ./LunaSpy -d board_name firmware channel -n run_number
    if( XDAQ_FLAG ):
        r_spy.start(daq_state)
    
    # If we save the data, add the run to database
    if( save or not XDAQ_FLAG ):
        run = daq_state['run']
        time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

        # Update metadata in the database check first if it exists already
        try:
            run_metadata = RunMetadata.query.filter_by(run_number=run).first()
            if not run_metadata:
                run_metadata = RunMetadata(run_number=run, start_time=datetime.now(), user_id=get_current_user())
                db.session.add(run_metadata)
                db.session.commit()
            else:
                run_metadata.start_time = time
                run_metadata.end_time = None
            
                db.session.commit()
        except:
            pass

    time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    daq_state['start_time'] = time

    # Update the daq_state file
    update_project(daq_state)

    # FIX: Start the thread to check for crashes
    #start_thread = True
    #t_crash = threading.Thread(target=detect_crash)
    #t_crash.start()

    return jsonify({'message': 'Run started successfully !'}), 200

@bp.route("/experiment/stop_run", methods=['POST'])
@jwt_required_custom
def stop_run( ):
    global daq_state, r_spy, start_thread, t_crash

    # First stop the spy
    r_spy.stop()
    
    time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    
    # Stop the XDAQ
    if( XDAQ_FLAG ):
        topology.halt( )

    # If we save the data, update the run in the database
    if( daq_state['save'] or not XDAQ_FLAG and daq_state['running'] ):
        daq_state['run'] += 1

    daq_state['running'] = False
    daq_state['start_time'] = None

    # Update the daq_state file
    update_project(daq_state)

    # Update metadata in the database
    try:
        if( daq_state['save'] or not XDAQ_FLAG ):
            run_metadata = RunMetadata.query.filter_by(run_number=daq_state['run']-1).first()
            run_metadata.end_time = datetime.now()
            db.session.commit()
    except:
        pass

    return jsonify({'message': 'Run stopped successfully !'}), 200

@bp.route("/experiment/add_note", methods=['POST'])
@jwt_required_custom
def add_note():
    data = request.get_json()
    run_number = data['run_number']
    note = data['note']
    
    run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
    if run_metadata:
        run_metadata.notes = note
        db.session.commit()
        return jsonify({'message': 'Note added successfully'}), 200
    return jsonify({'message': 'Run not found'}), 404

@bp.route("/experiment/get_run_metadata/<run_number>", methods=['GET'])
@jwt_required_custom
def get_run_metadata(run_number):
    run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
    if run_metadata:
        return jsonify({
            'run_number': run_metadata.run_number,
            'start_time': run_metadata.start_time,
            'end_time': run_metadata.end_time,
            'notes': run_metadata.notes,
            'accumulated_charge': run_metadata.accumulated_charge,
            'user_id': run_metadata.user_id
        }), 200
    return jsonify({'message': 'Run not found'}), 404

@bp.route("/experiment/get_run_metadata", methods=['GET'])
@jwt_required_custom
def get_all_run_metadata():
    run_metadata = RunMetadata.query.all()
    # order by run number reversed
    run_metadata = sorted(run_metadata, key=lambda x: x.run_number, reverse=True)
    if run_metadata:
        metadata = []
        for run in run_metadata:
            metadata.append({
                'run_number': run.run_number,
                'start_time': run.start_time,
                'end_time': run.end_time,
                'notes': run.notes,
                'accumulated_charge': run.accumulated_charge,
                'user_id': run.user_id
            })
        return jsonify(metadata), 200
    return jsonify({'message': 'No runs found'}), 404

# Route for adding CAEN boards
@bp.route("/experiment/add_board", methods=['POST'])
@jwt_required_custom
def add_caen():
    global daq_state

    board = request.get_json()
        
    # Add the new board to the list
    daq_state['boards'].append(board)

    # Get board name and dpp
    board_name = board['name']
    dpp = board['dpp']

    # Chekc if default configuration file exists
    dpp = "PSD" if dpp == 0 else "PHA"
    if os.path.exists(f"json/{board_name}_{dpp}.json"):
        # Copy to "conf" directory
        os.system(f"cp json/{board_name}_{dpp}.json conf/{board_name}_{board['id']}.json")

    # Create the calibration file
    os.system(f"touch calib/{board_name}_{board['id']}.cal")
    with open(f"calib/{board_name}_{board['id']}.cal", 'w') as f:
        for i in range( board['chan'] ):
            f.write(f"0.0 1.0\n")

    # Update the project
    update_project(daq_state)

    return jsonify(daq_state['boards'])

# Route for removing a CAEN board
@bp.route("/experiment/remove_board", methods=['POST'])
@jwt_required_custom
def remove_caen():
    global daq_state

    index = request.get_json()["id"]

    index = int(index)

    # Remove the board based on its index in the list
    if 0 <= index < len(daq_state['boards']):
        os.system(f"rm calib/{daq_state['boards'][index]['name']}_{daq_state['boards'][index]['id']}.cal")
        _ = daq_state['boards'].pop(index)

    # Update the project
    update_project(daq_state)

    return jsonify(daq_state['boards'])

# Route to update save data
@bp.route("/experiment/set_save_data", methods=['POST'])
@jwt_required_custom
def update_save_data():
    global daq_state
    save = request.get_json()["value"]
    daq_state['save'] = save
    return jsonify(daq_state['save'])

# Route to update limit size
@bp.route("/experiment/set_limit_data_size", methods=['POST'])
@jwt_required_custom
def update_limit_size():
    global daq_state
    limit_size = request.get_json()["value"]
    daq_state['limit_size'] = limit_size
    return jsonify(daq_state['limit_size'])

# Route to update file size limit
@bp.route("/experiment/set_data_size_limit", methods=['POST'])
@jwt_required_custom
def update_file_size_limit():
    global daq_state
    file_size_limit = request.get_json()["value"]
    daq_state['file_size_limit'] = file_size_limit
    return jsonify(daq_state['file_size_limit'])

# Route to get the save data
@bp.route("/experiment/get_save_data", methods=['GET'])
@jwt_required_custom
def get_save_data():
    global daq_state
    return jsonify(daq_state['save'])

# Route to get the limit size
@bp.route("/experiment/get_limit_data_size", methods=['GET'])
@jwt_required_custom
def get_limit_size():
    global daq_state
    return jsonify(daq_state['limit_size'])

# Route to get the file size limit
@bp.route("/experiment/get_data_size_limit", methods=['GET'])
@jwt_required_custom
def get_file_size_limit():
    global daq_state
    return jsonify(daq_state['file_size_limit'])

# Route for sending CAEN board
@bp.route("/experiment/get_board_configuration", methods=['GET'])
@jwt_required_custom
def get_board_configuration():
    global daq_state
    return jsonify(daq_state['boards'])

# Get run number from the database
@bp.route("/experiment/get_run_number", methods=['GET'])
@jwt_required_custom
def get_run_number():
    global daq_state
    return jsonify(daq_state['run'])

# Set run number in the database
@bp.route("/experiment/set_run_number", methods=['POST'])
@jwt_required_custom
def set_run_number():
    global daq_state
    run_number = request.get_json()["value"]
    daq_state['run'] = run_number
    return jsonify(daq_state['run'])

# FastAPI route to use this function
@bp.route("/experiment/check_run_directory", methods=['GET'])
@jwt_required_custom
def check_run_directory():
    run_number = daq_state['run']
    run_dir = f"data/run{run_number}"
    # Check if the directory exists
    if os.path.exists(run_dir):
        return jsonify(True)
    return jsonify(False)

# Get run status
@bp.route("/experiment/get_run_status", methods=['GET'])
@jwt_required_custom
def get_run_status():
    global daq_state
    try:
        status = topology.get_daq_status( )
        if status == "Running":
            daq_state['running'] = True
        else:
            daq_state['running'] = False
    except:
        daq_state['running'] = False
        pass
    return jsonify(daq_state['running'])

@bp.route("/experiment/get_start_time", methods=['GET'])
@jwt_required_custom
def get_start_time():
    global daq_state
    return jsonify(daq_state['start_time'])

@bp.route('/waveforms/1/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_wave1(board_id, channel):
    idx = 0
    for board in daq_state['boards']:
        if int(board['id']) < int(board_id):
            idx += board['chan']
    idx += int(channel)
    histo = r_spy.get_object("wave1", idx)
    obj = TBufferJSON.ConvertToJSON(histo)
    return str(obj.Data())

@bp.route('/waveforms/2/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_wave2(board_id, channel):
    idx = 0
    for board in daq_state['boards']:
        if int(board['id']) < int(board_id):
            idx += board['chan']
    idx += int(channel)
    histo = r_spy.get_object("wave2", idx)
    obj = TBufferJSON.ConvertToJSON(histo)

    return str(obj.Data())

@bp.route('/waveforms/activate', methods=['POST'])
@jwt_required_custom
def activate_wave():
    # We must change the JSON configuration file to enable waveforms
    for board in daq_state['boards']:
        filename = f"conf/{board['name']}_{board['id']}.json"
        with open(filename, 'r') as f:
            data = json.load(f)
        string = data['registers']['reg_8000']["value"]
        value = int(string, 16)
        value |= 1 << 16
        data['registers']['reg_8000']["value"] = hex(value)
        with open(filename, 'w') as f:
            json.dump(data, f, indent=4)

    return jsonify({'message': 'Waveforms activated successfully !'}), 200

@bp.route('/waveforms/deactivate', methods=['POST'])
@jwt_required_custom
def deactivate_wave():
    # We must change the JSON configuration file to enable waveforms
    for board in daq_state['boards']:
        filename = f"conf/{board['name']}_{board['id']}.json"
        with open(filename, 'r') as f:
            data = json.load(f)
        string = data['registers']['reg_8000']["value"]
        value = int(string, 16)
        value &= ~(1 << 16)
        data['registers']['reg_8000']["value"] = hex(value)
        with open(filename, 'w') as f:
            json.dump(data, f, indent=4)

    return jsonify({'message': 'Waveforms deactivated successfully !'}), 200

@bp.route('/waveforms/status', methods=['GET'])
@jwt_required_custom
def wave_status():
    # We must check if waveforms are enabled
    for board in daq_state['boards']:
        filename = f"conf/{board['name']}_{board['id']}.json"
        with open(filename, 'r') as f:
            data = json.load(f)

        string = data['registers']['reg_8000']["value"]
        value = int(string, 16)
        if (value & (1 << 16)) == 0:
            return jsonify(False)

    return jsonify(True)

@bp.route('/experiment/xdaq/file_bandwidth', methods=['GET'])
@jwt_required_custom
def get_file_bandwith( ):
    
    # For all xdaq actors in topology get the file bandwith
    if( daq_state['running'] and XDAQ_FLAG ):
        actors = topology.get_all_actors()
        data = 0
        for actor in actors:
            for a in actor:
                data += float(a.get_file_bandwith( ))

        return jsonify(data)
    
    return jsonify(0)

@bp.route('/experiment/xdaq/output_bandwidth', methods=['GET'])
@jwt_required_custom
def get_output_bandwith( ):
    
    # For all xdaq actors in topology get the file bandwith
    if( daq_state['running'] and XDAQ_FLAG ):
        actors = topology.get_all_actors()
        data = 0
        for actor in actors:
            for a in actor:
                data += float(a.get_output_bandwith( ))

        return jsonify(data)
    
    return jsonify(0)

@bp.route('/experiment/xdaq/reset', methods=['POST'])
@jwt_required_custom
def reset( ):
    try:
        r_spy.stop()
    except:
        pass
    topology = xdaq.topology("conf/topology.xml")
    topology.load_topology( )
    topology.display()
    container.reset( )
    print( "Container started...")
    topology.configure_pt( )
    print( "PT configured...")
    topology.enable_pt( )
    print( "PT enabled...")
    return jsonify(0)

# Route to serve all the data for a given run number
@bp.route('/histograms/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_histo(board_id, channel):
    idx, dpp = get_info(board_id, channel, daq_state['boards'])
    if( dpp == "DPP-PHA" ):
        histo = r_spy.get_object("energy", idx)
    else:
        histo = r_spy.get_object("qlong", idx)

    histo.Rebin( 16 )

    # Fill the histogram with random numbers
    if( not XDAQ_FLAG ):
        histo.FillRandom("gaus", 1000)

    obj = TBufferJSON.ConvertToJSON(histo)
    return str(obj.Data())

# Route to serve all the data for a given run number
@bp.route('/histograms/<board_id>/<channel>/<roi_min>/<roi_max>', methods=['GET'])
@jwt_required_custom
def get_roi_histo(board_id, channel, roi_min, roi_max):
    idx, dpp = get_info(board_id, channel, daq_state['boards'])
    if( dpp == "DPP-PHA" ):
        histo = r_spy.get_object("energy", idx)
    else:
        histo = r_spy.get_object("qlong", idx)

    histo.Rebin( 16 )

    # Fill the histogram with random numbers
    if( not XDAQ_FLAG ):
        histo.FillRandom("gaus", 1000)

    h1 = TH1F(histo)
    h1.GetXaxis( ).SetRange(h1.FindBin(int(roi_min)), h1.FindBin(int(roi_max))-1)
    h1.SetLineColor(2)
    h1.SetFillStyle(3001)
    h1.SetFillColorAlpha(2, 0.3)
    h1.SetLineWidth(2)
    obj = str(TBufferJSON.ConvertToJSON(h1).Data())
    h1.Delete( )
    del h1
    return obj

# Route to serve all the data for a given run number
@bp.route('/roi/<board_id>/<channel>/<roi_min>/<roi_max>', methods=['GET'])
@jwt_required_custom
def get_roi_integral(board_id, channel, roi_min, roi_max):
    idx, dpp = get_info(board_id, channel, daq_state['boards'])
    if( dpp == "DPP-PHA" ):
        histo = r_spy.get_object("energy", idx)
    else:
        histo = r_spy.get_object("qlong", idx)
    histo.Rebin( 16 )
    integral = histo.Integral(histo.FindBin(int(roi_min)), histo.FindBin(int(roi_max)))
    return jsonify(integral)

@bp.route('/experiment/boards/<id>/<setting>', methods=['GET'])
@jwt_required_custom
def get_setting( id, setting ):
    key = "reg_{}".format(setting)
    for board in daq_state['boards']:
        if board['id'] == id:
            filename = "conf/{}_{}.json".format(board['name'], board['id'])
            with open(filename, 'r') as f:
                data = json.load(f)
            value = data['registers'][key]['value']
            # Convert from hex 0x to int
            return jsonify(int(value, 16))
    return jsonify(-1)

@bp.route('/experiment/boards/<id>/<setting>/<value>', methods=['GET'])
@jwt_required_custom
def set_setting( id, setting, value ):
    key = "reg_{}".format(setting)
    try:
        for board in daq_state['boards']:
            if board['id'] == id:
                filename = "conf/{}_{}.json".format(board['name'], board['id'])
                with open(filename, 'r') as f:
                    data = json.load(f)
                data['registers'][key]['value'] = hex(int(value))
                with open(filename, 'w') as f:
                    json.dump(data, f, indent=4)
        # Return success
        return jsonify(0)
    except:
        # Return failure
        return jsonify(-1)