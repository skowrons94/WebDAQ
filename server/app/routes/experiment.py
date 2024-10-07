# app/routes/experiment.py
from flask import Blueprint, request, jsonify
from app import db
from app.models.run_metadata import RunMetadata
from app.utils.jwt_utils import jwt_required_custom, get_current_user
from app.services.topology_manager import TopologyManager

import datetime

bp = Blueprint('experiment', __name__)

tm = TopologyManager("conf/topology.xml")
tm.load_topology()
tm.display()

#set the run number to the last run number in the database
run_number = 0

@bp.route("/start_run", methods=['POST'])
@jwt_required_custom
def start_run():
    global run_number
    user_id = get_current_user()
    run_number = RunMetadata.query.count() + 1

    run_metadata = RunMetadata(user_id=user_id, start_time=datetime.datetime.now(), run_number=run_number)
    db.session.add(run_metadata)
    db.session.commit()
    
    # Start the run logic here
    #tm.start()
    print("Run started!", run_metadata.run_number)
    return jsonify({'message': 'Run started!', 'run_number': run_metadata.run_number}), 200

@bp.route("/stop_run", methods=['POST'])
@jwt_required_custom
def stop_run():
    global run_number
    user_id = get_current_user()
    run_metadata = RunMetadata.query.filter_by(user_id=user_id, end_time=None).first()
    if run_metadata:
        run_metadata.end_time = datetime.datetime.now()
        db.session.commit()
        
        # Stop the run logic here
        #tm.halt()

        run_number = run_number + 1

        
        return jsonify({'message': 'Run stopped!', 'run_number': run_metadata.run_number}), 200
    return jsonify({'message': 'No active run found'}), 404

@bp.route("/add_note", methods=['POST'])
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

@bp.route("/get_run_metadata", methods=['GET'])
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