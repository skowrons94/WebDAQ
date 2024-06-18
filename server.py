from flask import Flask, request, jsonify, render_template, redirect
from TopologyManager import TopologyManager

app = Flask(__name__)

run_number = 0
is_running = False

# Read the topology
tm = TopologyManager( "conf/topology.xml" )
tm.load_topology( )

# Display the topology
tm.display()

#run_number = tm.get_run_number()

# Configure the TCP/IP links
#tm.configure_pt( )
#tm.enable_pt( )

# return form with a button to go back to / page
@app.route("/start_run", methods=['POST'])
def start_run():
    global is_running
    # start the run
    is_running = True
    #tm.start()
    return jsonify({'message': 'Run started!',
                    'run_number': run_number})

@app.route("/stop_run", methods=['POST'])
def stop_run():
    global run_number, is_running
    # stop the run
    #tm.halt()
    run_number += 1
    is_running = False
    return jsonify({'message': 'Run stopped!',
                    'run_number': run_number-1})

@app.route("/set_run_number", methods=['GET','POST'])
def set_run_number():
    global run_number

    run_number = int(request.form['run_number'])
    #tm.set_run_number(run_number)

    return jsonify({'message': 'Run number set!',
                    'run_number': run_number})

@app.route("/get_run_number", methods=['GET','POST'])
def get_run_number():
    global run_number
    return jsonify({'run_number': run_number})

@app.route("/", methods=['GET','POST'])
def index():
    global run_number, is_running
    if request.method == 'POST':
        if request.form.get('start'):
            print("Starting run")
            start_run()
            return redirect('/')
        elif request.form.get('stop'):
            print("Stopping run")
            stop_run()
            return redirect('/')
    return render_template('index.html', run_number=run_number, is_running=is_running)

if __name__ == "__main__":
    app.run(debug=True)
    