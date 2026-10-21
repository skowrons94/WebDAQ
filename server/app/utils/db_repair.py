"""
Bring a project's app.db to the schema the models expect, whatever state it is in.

A measurement directory's database outlives the code that created it: it can
predate the migrations (db.create_all), carry a revision from a rewritten
history, be stamped at the head while missing the columns that head adds, be
half created, or simply be unreadable after a crash or a full disk. Alembic
alone stops at the first of these, and the server then starts in a
half-broken state where runs are taken but not recorded. Since the people
starting LunaDAQ are running an experiment, not maintaining a database, every
case is repaired here, keeping a copy of the file before it is touched:

* unreadable file      -> set aside as app.db.unreadable-<stamp>, a fresh one created
* missing tables       -> created
* missing columns      -> added (the models' new columns are all nullable)
* wrong/unknown stamp  -> re-stamped at the head once the tables match

Only SQLite files are repaired; any other database just gets the upgrade.
"""

import logging
import os
import shutil
import sqlite3
from datetime import datetime
from typing import List

logger = logging.getLogger(__name__)


def _sqlite_path(uri: str):
    if not uri or not uri.startswith("sqlite:///"):
        return None
    path = uri[len("sqlite:///"):]
    return None if path in ("", ":memory:") else path


def _stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


LOCK_WAIT_S = 10.0     # how long a lock held by another program is waited for


def _readable(path: str) -> bool:
    """False only for a file that is damaged: not a database, or malformed.

    A database another program holds locked (a SQLite browser, a backup, a
    notebook) is busy, not broken: it must never be set aside for that.
    """
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=LOCK_WAIT_S)
        try:
            rows = con.execute("PRAGMA quick_check").fetchall()
        finally:
            con.close()
        return rows == [("ok",)]
    except sqlite3.OperationalError as e:
        text = str(e).lower()
        if "locked" in text or "busy" in text:
            logger.warning(f"{path} is locked by another program; leaving it as it is")
            return True
        return False
    except sqlite3.DatabaseError:
        return False


def missing_schema(db) -> List[str]:
    """Tables and columns the models declare that the database lacks."""
    from sqlalchemy import inspect as sa_inspect

    inspector = sa_inspect(db.engine)
    existing = set(inspector.get_table_names())
    missing = []
    for table in db.metadata.sorted_tables:
        if table.name not in existing:
            missing.append(f"{table.name} (whole table)")
            continue
        have = {c["name"] for c in inspector.get_columns(table.name)}
        missing += [f"{table.name}.{c.name}" for c in table.columns if c.name not in have]
    return missing


def _add_missing(db) -> None:
    """Create missing tables and add missing columns, in place."""
    from sqlalchemy import inspect as sa_inspect, text
    from sqlalchemy.schema import CreateColumn

    engine = db.engine
    inspector = sa_inspect(engine)
    existing = set(inspector.get_table_names())
    db.metadata.create_all(engine, tables=[t for t in db.metadata.sorted_tables
                                           if t.name not in existing])
    with engine.begin() as con:
        for table in db.metadata.sorted_tables:
            if table.name not in existing:
                continue
            have = {c["name"] for c in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in have:
                    continue
                ddl = CreateColumn(column).compile(dialect=engine.dialect)
                con.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN {ddl}'))


def repair_database(flask_app, migrations_dir: str) -> List[str]:
    """Upgrade the database, repairing it if the upgrade cannot.

    Returns what was done, for the caller to report; raises if the schema
    still does not match the models afterwards.
    """
    from flask_migrate import stamp, upgrade
    from app import db

    actions: List[str] = []
    path = _sqlite_path(flask_app.config.get("SQLALCHEMY_DATABASE_URI", ""))

    if path and os.path.exists(path) and os.path.getsize(path) and not _readable(path):
        aside = f"{path}.unreadable-{_stamp()}"
        os.replace(path, aside)
        for suffix in ("-wal", "-shm", "-journal"):
            if os.path.exists(path + suffix):
                os.replace(path + suffix, aside + suffix)
        actions.append(f"the database file was unreadable: kept as {aside}, a new one created")

    with flask_app.app_context():
        try:
            upgrade(directory=migrations_dir)
            upgrade_error = None
        except (Exception, SystemExit) as e:
            # Flask-Migrate logs Alembic's error and calls sys.exit(1).
            upgrade_error = (str(e).splitlines() or ["alembic upgrade failed"])[0]
            if isinstance(e, SystemExit):
                upgrade_error = "alembic upgrade failed, see the log above"
        db.engine.dispose()

        missing = missing_schema(db)
        if missing:
            if not path:
                raise RuntimeError(upgrade_error or f"missing {', '.join(missing)}")
            backup = f"{path}.bak.{_stamp()}"
            shutil.copy2(path, backup)
            _add_missing(db)
            actions.append(f"added {', '.join(missing)} (backup at {backup})")
            missing = missing_schema(db)
            if missing:
                raise RuntimeError(f"could not add {', '.join(missing)}")

        if upgrade_error or actions:
            # The tables now match the models; record that, replacing whatever
            # revision (unknown, older, none) the file carried. Alembic resolves
            # the current revision even to stamp, so an unknown one is cleared
            # by hand first.
            from sqlalchemy import text
            with db.engine.begin() as con:
                con.execute(text("DROP TABLE IF EXISTS alembic_version"))
            stamp(directory=migrations_dir)
            if upgrade_error:
                actions.append(f"migration revision re-stamped at the head ({upgrade_error})")
    return actions
