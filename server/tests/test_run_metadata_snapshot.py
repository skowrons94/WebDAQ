"""Portable run metadata snapshots and the routes that keep them current."""

import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime

os.environ.setdefault("TEST_FLAG", "True")

from app import create_app, db  # noqa: E402
from app.models.run_metadata import RunMetadata  # noqa: E402
from app.routes.current import _persist_run_charge  # noqa: E402
from app.services.run_metadata_snapshot import sync_run_metadata_file  # noqa: E402
from app.utils.jwt_utils import generate_token  # noqa: E402
from config import Config  # noqa: E402


class _ExampleRun:
    run_number = 42
    start_time = datetime(2026, 7, 29, 10, 0, 0)
    end_time = datetime(2026, 7, 29, 10, 1, 2, 345000)
    terminal_voltage = 1200.0
    probe_voltage = 24.5
    run_type = "physics"
    target_name = "TaN"
    accumulated_charge = 3.75
    user_id = 7
    notes = "# Shift note\n\nBeam was stable."
    flag = "good"
    sync_mode = "daisy-chain"

    @staticmethod
    def get_software_versions():
        return {"WebDAQ": "test-version"}

    @staticmethod
    def get_board_info():
        return [{"id": 0, "model": "V1730"}]


class SnapshotWriterTests(unittest.TestCase):
    def setUp(self):
        self.previous_directory = os.getcwd()
        self.workdir = tempfile.mkdtemp(prefix="metadata-snapshot-")
        os.chdir(self.workdir)
        os.makedirs("data/run42")

        files = {
            "run_42_0000.caendat": b"\x01\x02\x03",
            "V1730_0.json": b'{"register": 12}',
            "current.txt": b"0 1.0\n1 2.0\n",
            "stats.csv": b"time,rate\n0,123\n",
            "run_42.root": b"ROOT",
            "analysis.log": b"complete\n",
        }
        for name, contents in files.items():
            with open(os.path.join("data/run42", name), "wb") as output:
                output.write(contents)

    def tearDown(self):
        os.chdir(self.previous_directory)
        shutil.rmtree(self.workdir)

    def test_snapshot_is_complete_and_versioned(self):
        self.assertTrue(sync_run_metadata_file(_ExampleRun()))

        with open("data/run42/metadata.json") as source:
            metadata = json.load(source)

        self.assertEqual(metadata["Schema Version"], 1)
        self.assertEqual(metadata["Run Number"], 42)
        self.assertEqual(metadata["Duration (s)"], 62.345)
        self.assertEqual(metadata["User ID"], 7)
        self.assertEqual(metadata["Notes"], "# Shift note\n\nBeam was stable.")
        self.assertEqual(metadata["Acquisition"]["Synchronisation"], "daisy-chain")
        self.assertEqual(metadata["Files"]["Data"], ["run_42_0000.caendat"])
        self.assertEqual(metadata["Files"]["Board Configuration"], ["V1730_0.json"])
        self.assertEqual(metadata["Files"]["Current"], ["current.txt"])
        self.assertEqual(metadata["Files"]["Statistics"], ["stats.csv"])
        self.assertEqual(metadata["Files"]["ROOT"], ["run_42.root"])
        self.assertEqual(metadata["Files"]["Other"], ["analysis.log"])

        manifest = {item["Name"]: item for item in metadata["Files"]["Manifest"]}
        self.assertEqual(set(manifest), {
            "V1730_0.json",
            "analysis.log",
            "current.txt",
            "run_42.root",
            "run_42_0000.caendat",
            "stats.csv",
        })
        self.assertEqual(manifest["stats.csv"]["Role"], "statistics")
        self.assertEqual(manifest["run_42_0000.caendat"]["Bytes"], 3)
        self.assertNotIn("metadata.json", manifest)

    def test_rewrite_replaces_the_document_without_leaving_a_temp_file(self):
        self.assertTrue(sync_run_metadata_file(_ExampleRun()))
        _ExampleRun.notes = "Updated **Markdown** note"
        try:
            self.assertTrue(sync_run_metadata_file(_ExampleRun()))
        finally:
            _ExampleRun.notes = "# Shift note\n\nBeam was stable."

        with open("data/run42/metadata.json") as source:
            self.assertEqual(json.load(source)["Notes"], "Updated **Markdown** note")
        leftovers = [
            name for name in os.listdir("data/run42")
            if name.startswith(".metadata.")
        ]
        self.assertEqual(leftovers, [])


class _MemoryConfig(Config):
    SQLALCHEMY_DATABASE_URI = "sqlite://"
    TESTING = True


class MetadataMutationRouteTests(unittest.TestCase):
    RUN_NUMBER = 876543

    @classmethod
    def setUpClass(cls):
        cls.app = create_app(_MemoryConfig)
        with cls.app.app_context():
            db.create_all()
            cls.token = generate_token(7)
        cls.client = cls.app.test_client()
        cls.auth = {"Authorization": f"Bearer {cls.token}"}

    @classmethod
    def tearDownClass(cls):
        with cls.app.app_context():
            db.drop_all()

    def setUp(self):
        self.run_directory = os.path.join("data", f"run{self.RUN_NUMBER}")
        os.makedirs(self.run_directory, exist_ok=True)
        with self.app.app_context():
            db.session.add(RunMetadata(
                run_number=self.RUN_NUMBER,
                start_time=datetime(2026, 7, 29, 10, 0, 0),
                user_id=7,
                notes="Original",
            ))
            db.session.commit()

    def tearDown(self):
        with self.app.app_context():
            run = RunMetadata.query.filter_by(run_number=self.RUN_NUMBER).first()
            if run:
                db.session.delete(run)
                db.session.commit()
        shutil.rmtree(self.run_directory, ignore_errors=True)

    def post(self, path, payload):
        return self.client.post(path, headers=self.auth, json=payload)

    def metadata(self):
        with open(os.path.join(self.run_directory, "metadata.json")) as source:
            return json.load(source)

    def test_notes_flags_and_run_fields_refresh_the_file(self):
        response = self.post("/experiment/update_run_notes", {
            "run_number": self.RUN_NUMBER,
            "notes": "## Formatted note\n\n- one\n- two",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.metadata()["Notes"], "## Formatted note\n\n- one\n- two")

        response = self.post("/experiment/update_run_flag", {
            "run_number": self.RUN_NUMBER,
            "flag": "good",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.metadata()["Flag"], "good")

        response = self.post("/experiment/add_run_metadata", {
            "run_number": self.RUN_NUMBER,
            "target_name": "TaN",
            "terminal_voltage": 1250,
            "probe_voltage": 24,
            "run_type": "physics",
        })
        self.assertEqual(response.status_code, 200)
        metadata = self.metadata()
        self.assertEqual(metadata["Target Name"], "TaN")
        self.assertEqual(metadata["Terminal Voltage"], 1250)
        self.assertEqual(metadata["Probe Voltage"], 24)
        self.assertEqual(metadata["Run Type"], "physics")

    def test_persisted_charge_refreshes_the_file(self):
        _persist_run_charge(self.RUN_NUMBER, 149.75)
        self.assertEqual(self.metadata()["Accumulated Charge"], 149.75)


if __name__ == "__main__":
    unittest.main()
