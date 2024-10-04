import os
import csv
import time

import subprocess
import pickle as pkl

from datetime import datetime
from flask import Flask, render_template, request, redirect, url_for, send_from_directory, jsonify

from xdaq import topology, container

app = Flask(__name__)

def dump_state(state):
    with open('web/boards.pkl', 'wb') as f:
        pkl.dump(state, f)

def write_ruconf(state):
    if not os.path.exists('conf'): 
        os.makedirs('conf')
    with open('conf/RUCaen.conf', 'w') as f:
        f.write(f"NumberOfBoards {len(state['caen_boards'])}\n\n")
        for board in state['caen_boards']:
            conf = "/home/xdaq/project/conf/{}_{}.json".format(board['name'], board['id'])
            f.write(f"Board {board['id']} {board['name']} {board['vme']} {board['link_type']} {board['link_num']} {board['dpp']}\n")
            f.write(f"BoardConf {board['id']} {conf}\n")

def write_lfconf(state):
    if not os.path.exists('conf'):
        os.makedirs('conf')
    with open('conf/LocalFilter.conf', 'w') as f:
        f.write(f"SaveDataDir .\n\n")
        for board in state['caen_boards']:
            f.write(f"SpecPrefix {board['id']} {board['name']}\n")
            if board["dpp"] == "DPP-PHA": dpp = "DPP_PHA"
            elif board["dpp"] == "DPP-PSD": dpp = "DPP_PSD"
            f.write(f"Board {board['id']} {board['name']} {dpp} {board['chan']} 0 1 1\n")
        f.write("GraphiteServer lunaserver 2003\n")

def write_buconf(state):
    if not os.path.exists('conf'):
        os.makedirs('conf')
    with open('conf/Builder.conf', 'w') as f:
        for board in state['caen_boards']:
            # Write all 1 for each channel
            for i in range(int(board['chan'])):
                f.write(f"1")
            f.write("\n")

# Path to the CSV file
CSV_FILE = 'logbook.csv'

# Check if CSV exists, if not, create it with predefined columns
def check_and_create_csv():
    if not os.path.exists(CSV_FILE):
        with open(CSV_FILE, mode='w', newline='') as file:
            writer = csv.writer(file)

# Read CSV and return data as list of rows
def read_csv():
    if os.path.exists(CSV_FILE):
        with open(CSV_FILE, mode='r') as file:
            reader = csv.reader(file)
            rows = list(reader)
            return rows
    return []

# Write data to CSV
def write_csv(data):
    with open(CSV_FILE, mode='w', newline='') as file:
        writer = csv.writer(file)
        writer.writerows(data)

# Check if "web" directory exists, if not create it
if not os.path.exists('web'):
    os.makedirs('web')

# Check if "web/boards.pkl" exists, if not create it
if os.path.exists('web/boards.pkl'):
    with open('web/boards.pkl', 'rb') as f:
        daq_state = pkl.load(f)
else:
    # Variables to store the current DAQ system state and CAEN boards
    daq_state = {
        'is_running': False,
        'run_number': 0,
        'param1': 1,
        'param2': 1,
        'param3': 1,
        'param4': 1,
        'message': "Nothing",
        'caen_boards': []
    }

tm = topology("conf/topology.xml")
tm.load_topology( )
tm.display()

#dm = container()
#dm.start()

time.sleep(2)

#tm.configure_pt( )
#tm.enable_pt( )

def setup_daq( ):
    write_ruconf(daq_state)
    write_lfconf(daq_state)
    write_buconf(daq_state)
    tm.configure( )

def start_daq( ):
    tm.start( )
    # Spy is started by starting the LunaSpy application
    # It must be launched with "-d" that follow board name, firmware and channel and "-n" that follow the run number
    # Example: ./LunaSpy -d board_name firmware channel -n run_number
    cmd = "LunaSpy"
    for board in daq_state['caen_boards']:
        firmware = 0 if board['dpp'] == "DPP-PHA" else 1
        cmd += f" -d {board['name']} {firmware} {board['chan']}"
    cmd += f" -n {daq_state['run_number']}"
    os.system(cmd)

def stop_daq( ):
    # Spy is stopped by killing the LunaSpy application
    os.system("pkill LunaSpy")
    tm.halt( )

# Initialize ROOT TWebCanvas
web_canvas = None

@app.route('/', methods=['GET', 'POST'])
def index():
    global daq_state
    if request.method == 'POST':
        if 'start' in request.form:
            daq_state['run_number'] = request.form.get('run_number')
            daq_state['param1'] = request.form.get('param1')
            daq_state['param2'] = request.form.get('param2')
            daq_state['param3'] = request.form.get('param3')
            daq_state['param4'] = request.form.get('param4')
            # Check if there are CAEN boards to start the DAQ
            if( len(daq_state['caen_boards']) == 0 ):
                daq_state['message'] = f"DAQ cannot be started without CAEN boards."
                return render_template('index.html', daq_state=daq_state, daq_running=daq_state['is_running'])
            #setup_daq( )
            #start_daq( )
            daq_state['message'] = f"DAQ started successfully :)"
            daq_state['is_running'] = True
            print(f"DAQ Started with Run Number: {daq_state['run_number']} and Parameters: {daq_state['parameters']}")
        elif 'stop' in request.form:
            #stop_daq( )
            daq_state['message'] = f"DAQ stopped successfully :)"
            daq_state['is_running'] = False
            print(f"DAQ Stopped.")
        return render_template('index.html', daq_state=daq_state, daq_running=daq_state['is_running'])

    return render_template('index.html', daq_state=daq_state, daq_running=daq_state['is_running'])

# Route for adding CAEN boards
@app.route('/add_caen', methods=['GET', 'POST'])
def add_caen():
    global daq_state
    if request.method == 'POST':
        # Add CAEN board parameters
        caen_board = {
            'id': request.form.get('id'),
            'name': request.form.get('name'),
            'vme': request.form.get('vme'),
            'link_type': request.form.get('link_type'),
            'link_num': request.form.get('link_num'),
            'dpp': request.form.get('dpp'),
            'chan': request.form.get('chan')
        }
        # Add the new board to the list
        daq_state['caen_boards'].append(caen_board)
        print(f"Added CAEN Board: {caen_board}")
        dump_state(daq_state)
        return redirect(url_for('add_caen'))

    # Render the CAEN board form page
    return render_template('add_caen.html', caen_boards=daq_state['caen_boards'])

# New route for removing a CAEN board
@app.route('/remove_caen/<int:board_index>', methods=['POST'])
def remove_caen(board_index):
    global daq_state
    # Remove the board based on its index in the list
    if 0 <= board_index < len(daq_state['caen_boards']):
        removed_board = daq_state['caen_boards'].pop(board_index)
        print(f"Removed CAEN Board: {removed_board}")
    return redirect(url_for('add_caen'))

# Route to serve all the data for a given run number
@app.route('/get_data/<run_number>/<filename>', methods=['GET'])
def get_data(run_number, filename):
    histogram_dir = f"histo/run{run_number}/"
    return send_from_directory(histogram_dir, filename)

@app.route('/get_files/<run_number>')
def get_files(run_number):
    histogram_dir = f"histo/run{run_number}/"
    try:
        files = [f for f in os.listdir(histogram_dir) if f.endswith('.dat')]
        return jsonify(files)
    except FileNotFoundError:
        return jsonify([])  # Return an empty list if the directory does not exist

@app.route('/histo', methods=['GET', 'POST'])
def histo():
    return render_template('histo.html', run_number=0, filename="")

@app.route('/json_editor', methods=['GET', 'POST'])
def json_editor():
    return render_template('json_editor.html', run_number=0, filename="")

@app.route('/converter', methods=['GET', 'POST'])
def converter():
    return render_template('converter.html', run_number=0, filename="")

@app.route('/logbook', methods=['GET', 'POST'])
def logbook():
    return render_template('logbook.html', run_number=0, filename="")

@app.route('/check-and-convert/<int:run_number>', methods=['GET'])
def check_and_convert(run_number):
    run_directory = f"data/run{run_number}/"
    response_output = ""

    # Check if the directory exists
    if not os.path.exists(run_directory):
        return f"Directory 'data/run{run_number}/' does not exist."

    # Define file paths
    caendat_file = os.path.join(run_directory, f"run{run_number}.caendat")
    adf_file = os.path.join(run_directory, f"run{run_number}.adf")

    # Check if .caendat file exists and run RUReader
    if os.path.exists(caendat_file):
        response_output += f"Found .caendat file: {caendat_file}\n"
        response_output += f"Running RUReader on {caendat_file}...\n"
        try:
            # Run RUReader command and capture output
            ru_output = subprocess.check_output(f"RUReader {caendat_file}", shell=True, stderr=subprocess.STDOUT, text=True)
            response_output += ru_output + "\n"
        except subprocess.CalledProcessError as e:
            response_output += f"Error executing RUReader: {e.output}\n"

        # Check if .adf file exists and run LFReader
        if os.path.exists(adf_file):
            response_output += f"Found .adf file: {adf_file}\n"
            response_output += f"Running LFReader on {adf_file}...\n"
            try:
                # Run LFReader command and capture output
                lf_output = subprocess.check_output(f"LFReader {adf_file}", shell=True, stderr=subprocess.STDOUT, text=True)
                response_output += lf_output + "\n"
            except subprocess.CalledProcessError as e:
                response_output += f"Error executing LFReader: {e.output}\n"
        else:
            response_output += f".adf file not found.\n"
    else:
        response_output += f".caendat file not found.\n"

    return response_output

@app.route('/get_csv', methods=['GET'])
def get_csv():
    rows = read_csv()
    return jsonify(rows)

@app.route('/save_csv', methods=['POST'])
def save_csv():
    data = request.json.get('data', [])
    write_csv(data)
    return jsonify({"status": "success"})

@app.route('/start_run', methods=['POST'])
def start_run():
    rows = read_csv()
    run_number = len(rows)  # Use row count as run number
    start_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    
    new_row = [run_number, '', '', start_time, '']
    rows.append(new_row)
    
    write_csv(rows)
    return jsonify({"status": "success", "run_number": run_number, "start_time": start_time})

@app.route('/stop_run', methods=['POST'])
def stop_run():
    run_number = request.json.get('run_number')
    stop_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    
    rows = read_csv()
    if run_number < len(rows):
        rows[run_number][4] = stop_time  # Stop time is in 5th column (index 4)
        write_csv(rows)
        return jsonify({"status": "success", "stop_time": stop_time})
    
    return jsonify({"status": "error", "message": "Run number not found"}), 404

if __name__ == '__main__':
    app.run(debug=True)