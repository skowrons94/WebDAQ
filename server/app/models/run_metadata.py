# app/models/run_metadata.py
import json

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

    # ── Acquisition provenance (FAIR) ────────────────────────────────────────
    # JSON snapshots captured at run start, so a dataset stays interpretable and
    # reproducible from its own record: what hardware took it, how it was
    # configured, and which software version produced it. Stored as JSON text so
    # the schema does not have to track the CAEN API's fields.
    board_info = db.Column(db.Text)         # list of per-board dicts (see CaenAcquisition.board_info_all)
    software_versions = db.Column(db.Text)  # dict: WebDAQ / caendaq / python / platform
    sync_mode = db.Column(db.String(32))    # 'daisy-chain' or 'independent'

    user = db.relationship('User', backref=db.backref('runs', lazy='dynamic'))

    # ── JSON helpers ─────────────────────────────────────────────────────────
    # The columns hold JSON text; these keep the (de)serialisation in one place
    # and never raise on a malformed or missing value.

    def get_board_info(self):
        """Per-board hardware snapshot as a list, or [] if not recorded."""
        return self._load_json(self.board_info, default=[])

    def set_board_info(self, boards):
        self.board_info = json.dumps(boards, indent=None, default=str) if boards else None

    def get_software_versions(self):
        """Software version snapshot as a dict, or {} if not recorded."""
        return self._load_json(self.software_versions, default={})

    def set_software_versions(self, versions):
        self.software_versions = json.dumps(versions, default=str) if versions else None

    @staticmethod
    def _load_json(raw, default):
        if not raw:
            return default
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return default
