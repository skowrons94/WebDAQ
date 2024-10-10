# app/routes/experiment.py
import os
import csv
from fastapi import HTTPException

import pickle as pkl

from datetime import datetime

from flask import Blueprint, request, jsonify, send_from_directory
from app import db
from app.models.run_metadata import RunMetadata
from app.utils.jwt_utils import jwt_required_custom, get_current_user

from app.services import xdaq

XDAQ_FLAG = False

bp = Blueprint('experiment', __name__)

def write_ruconf(state):
    if not os.path.exists('conf'): 
        os.makedirs('conf')
    with open('conf/RUCaen.conf', 'w') as f:
        f.write(f"NumberOfBoards {len(state['boards'])}\n\n")
        for board in state['boards']:
            conf = "/home/xdaq/project/conf/{}_{}.json".format(board['name'], board['id'])
            link_type = 0 if board['link_type'] == "Optical" else 1
            if board["dpp"] == "DPP-PHA": dpp = "DPP_PHA"
            elif board["dpp"] == "DPP-PSD": dpp = "DPP_PSD"
            f.write(f"Board {board['name']} {board['id']} {board['vme']} {board['link_type']} {board['link_num']} {dpp}\n")
            f.write(f"BoardConf {board['id']} {conf}\n")

def write_lfconf(state):
    if not os.path.exists('conf'):
        os.makedirs('conf')
    with open('conf/LocalFilter.conf', 'w') as f:
        f.write(f"SaveDataDir .\n\n")
        for board in state['boards']:
            f.write(f"SpecPrefix {board['id']} {board['name']}\n")
            if board["dpp"] == "DPP-PHA": dpp = "DPP_PHA"
            elif board["dpp"] == "DPP-PSD": dpp = "DPP_PSD"
            f.write(f"Board {board['id']} {board['name']} {dpp} {board['chan']} 0 1 1\n")
        f.write("GraphiteServer lunaserver 2003\n")

def write_buconf(state):
    if not os.path.exists('conf'):
        os.makedirs('conf')
    with open('conf/Builder.conf', 'w') as f:
        for board in state['boards']:
            # Write all 1 for each channel
            for i in range(int(board['chan'])):
                f.write(f"1")
            f.write("\n")

def update_project( daq_state ):

    with open('conf/boards.pkl', 'wb') as f: 
        pkl.dump(daq_state, f)

    write_ruconf(daq_state)
    write_lfconf(daq_state)
    write_buconf(daq_state)

# Check if CSV exists, if not, create it with predefined columns
def read_csv():
    CSV_FILE = 'logbook.csv'
    if not os.path.exists(CSV_FILE):
        return [['Run Number', 'Start Time', 'Stop Time']]
    else:
        with open(CSV_FILE, mode='r') as file:
            reader = csv.reader(file)
            print( reader )
            rows = list(reader)
            print( rows, type( rows ) )
            return rows
        
def write_csv(rows):
    with open('logbook.csv', mode='w') as file:
        writer = csv.writer(file)
        print( rows, type( rows ) )
        writer.writerows(rows)

def check_project( ):
    # Check if directory exists, if not create it
    if not os.path.exists('conf'): 
        os.makedirs('conf')
    # Check if exists, if not create it
    if os.path.exists('conf/boards.pkl'):
        with open('conf/boards.pkl', 'rb') as f: 
            daq_state = pkl.load(f)
    else:
        # Variables to store the current DAQ system state and CAEN boards
        daq_state = {
            'running': False,
            'run': 0,
            'coincidence_window': 20,
            'multiplicity': 1,
            'save': False,
            'limit_size': False,
            'file_size_limit': None,
            'boards': []
        }
        with open('conf/boards.pkl', 'wb') as f: 
            pkl.dump(daq_state, f)
    return daq_state

daq_state = check_project( )

# Path to the CSV file

topology = xdaq.topology("conf/topology.xml")
topology.load_topology( )
topology.display()

if( XDAQ_FLAG ):
    container = xdaq.container()
    container.start()

    topology.configure_pt( )
    topology.enable_pt( )

@bp.route("/experiment/start_run", methods=['POST'])
@jwt_required_custom
def start_run( ):
    global daq_state

    run = daq_state['run']
    save = daq_state['save']
    multiplicity = daq_state['multiplicity']
    coincidence_window = daq_state['coincidence_window']
    running = daq_state['running']

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

    # Update the daq_state file
    update_project(daq_state)

    # Start the XDAQ
    if( XDAQ_FLAG ):
        topology.set_coincidence_window(coincidence_window)
        topology.set_multiplicity(multiplicity)
        topology.set_run_number(run)
        topology.set_enable_files(save)
        topology.set_file_paths(f"/home/xdaq/project/data/run{run}/")
        topology.start( )

    daq_state['running'] = True
    
    # If we save the data, add the run to database
    if( save or not XDAQ_FLAG ):
        run = daq_state['run']
        time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        rows = read_csv()
        rows.append([run, time, None])
        write_csv(rows)
    
    # Run the Spy to  save the histograms to txt file in run directory
    # Example: ./LunaSpy -d board_name firmware channel -n run_number
    if( XDAQ_FLAG ):
        cmd = "LunaSpy"
        for board in daq_state['boards']:
            firmware = 0 if board['dpp'] == "DPP-PHA" else 1
            cmd += f" -d {board['name']} {firmware} {board['chan']}"
        cmd += f" -n {daq_state['run_number']}"
        os.system(cmd)

    return jsonify({'message': 'Run started successfully !'}), 200

@bp.route("/experiment/stop_run", methods=['POST'])
@jwt_required_custom
def stop_run( ):
    global daq_state
    
    # Stop the XDAQ
    if( XDAQ_FLAG ):
        os.system("pkill LunaSpy")
        topology.halt( )

    daq_state['running'] = False

    # If we save the data, update the run in the database
    if( daq_state['save'] or not XDAQ_FLAG ):
        time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        daq_state['run'] += 1
        rows = read_csv()
        rows[-1][2] = time
        write_csv(rows)

    # Update the daq_state file
    update_project(daq_state)

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

@bp.route("/experiment/get_run_metadata", methods=['GET'])
@jwt_required_custom
def get_run_metadata():
    run_number = request.args.get('run_number')
    run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
    if run_metadata:
        return jsonify({
            'run_number': run_metadata.run_number,
            'start_time': run_metadata.start_time,
            'end_time': run_metadata.end_time,
            'notes': run_metadata.notes,
            'user_id': run_metadata.user_id
        }), 200
    return jsonify({'message': 'Run not found'}), 404

# Route for adding CAEN boards
@bp.route("/experiment/add_board", methods=['POST'])
@jwt_required_custom
def add_caen():
    global daq_state

    board = request.get_json()
        
    # Add the new board to the list
    daq_state['boards'].append(board)

    print(board)

    # Get board name and dpp
    board_name = board['name']
    dpp = board['dpp']

    # Chekc if default configuration file exists
    dpp = "PSD" if dpp == 0 else "PHA"
    print(f"json/{board_name}_{dpp}.json")
    print(board_name)
    print(dpp)
    if os.path.exists(f"json/{board_name}_{dpp}.json"):
        # Copy to "conf" directory
        os.system(f"cp json/{board_name}_{dpp}.json conf/{board_name}_{board['id']}.json")

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
        _ = daq_state['boards'].pop(index)

    # Update the project
    update_project(daq_state)

    return jsonify(daq_state['boards'])

# Route to update coincidence window
@bp.route("/experiment/set_coincidence_window", methods=['POST'])
@jwt_required_custom
def update_coincidence_window():
    global daq_state

    coincidence_window = request.get_json()#["coincidence_window"]
    print(coincidence_window)
    daq_state['coincidence_window'] = coincidence_window

    return jsonify(daq_state['coincidence_window'])

# Route to update multiplicity
@bp.route("/experiment/set_multiplicity", methods=['POST'])
@jwt_required_custom
def update_multiplicity():
    global daq_state

    multiplicity = request.get_json()#["multiplicity"]
    print(multiplicity)
    daq_state['multiplicity'] = multiplicity

    return jsonify(daq_state['multiplicity'])

# Route to update save data
@bp.route("/experiment/set_save_data", methods=['POST'])
@jwt_required_custom
def update_save_data():
    global daq_state

    save = request.get_json()#["save"]
    print(save)
    daq_state['save'] = save

    return jsonify(daq_state['save'])

# Route to update limit size
@bp.route("/experiment/set_limit_data_size", methods=['POST'])
@jwt_required_custom
def update_limit_size():
    global daq_state

    limit_size = request.get_json()#["limit_data_size"]
    print(limit_size)
    daq_state['limit_size'] = limit_size

    return jsonify(daq_state['limit_size'])

# Route to update file size limit
@bp.route("/experiment/set_data_size_limit", methods=['POST'])
@jwt_required_custom
def update_file_size_limit():
    global daq_state

    file_size_limit = request.get_json()#["data_size_limit"]
    print(file_size_limit)
    daq_state['file_size_limit'] = file_size_limit

    return jsonify(daq_state['file_size_limit'])

# Route to get the coincidence window
@bp.route("/experiment/get_coincidence_window", methods=['GET'])
@jwt_required_custom
def get_coincidence_window():
    global daq_state
    return jsonify(daq_state['coincidence_window'])

# Route to get the multiplicity
@bp.route("/experiment/get_multiplicity", methods=['GET'])
@jwt_required_custom
def get_multiplicity():
    global daq_state
    return jsonify(daq_state['multiplicity'])

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
    print(daq_state['boards'])
    return jsonify(daq_state['boards'])

# Route to get the csv file
@bp.route("/experiment/get_csv", methods=['GET'])
@jwt_required_custom
def get_csv():
    return jsonify(read_csv())

# Route to save the csv file
@bp.route("/experiment/save_csv", methods=['POST'])
@jwt_required_custom
def save_csv():
    data = request.get_json()["data"]

    return jsonify({'message': 'CSV saved successfully !'}), 200

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
    run_number = request.get_json()["run_number"]
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
    return jsonify(daq_state['running'])

# Route to serve all the data for a given run number
@bp.route('/get_data/<run_number>/<filename>', methods=['GET'])
@jwt_required_custom
def get_data(run_number, filename):
    histogram_dir = f"data/run{run_number}/"
    return send_from_directory(histogram_dir, filename)

@bp.route("/get_files/<run_number>", methods=['GET'])
@jwt_required_custom
def get_files(run_number):
    histogram_dir = f"data/run{run_number}/"
    files = [f for f in os.listdir(histogram_dir) if f.endswith('.dat')]
    if(len(files) == 0):
        return jsonify([])
    else:
        return jsonify(files)