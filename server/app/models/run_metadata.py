# app/models/run_metadata.py
from app import db
from datetime import datetime

class RunMetadata(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    run_number = db.Column(db.Integer, index=True, unique=True)
    start_time = db.Column(db.DateTime, default=datetime.utcnow)
    end_time = db.Column(db.DateTime)
    notes = db.Column(db.Text)
    accumulated_charge = db.Column(db.Float)
    target_name = db.Column(db.String(64))
    terminal_voltage = db.Column(db.Float)
    probe_voltage = db.Column(db.Float)
    run_type = db.Column(db.String(64))
    flag = db.Column(db.String(32), default='unknown')  # 'good', 'unknown', 'bad'
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    
    user = db.relationship('User', backref=db.backref('runs', lazy='dynamic'))