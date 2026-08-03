"""Add acquisition provenance to run metadata.

Records, per run, the hardware that took the data (CAEN board identity,
firmware, licence and the acquisition registers as read back), the software that
produced it, and whether the boards were daisy-chained — so a dataset stays
interpretable and reproducible from its own record (FAIR).

Revision ID: b1c4e7a90f31
Revises: 8678444db75c
Create Date: 2026-07-27 15:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b1c4e7a90f31'
down_revision = '8678444db75c'
branch_labels = None
depends_on = None


NEW_COLUMNS = (
    ('board_info', lambda: sa.Column('board_info', sa.Text(), nullable=True)),
    ('software_versions', lambda: sa.Column('software_versions', sa.Text(), nullable=True)),
    ('sync_mode', lambda: sa.Column('sync_mode', sa.String(length=32), nullable=True)),
)


def _existing_columns():
    return {c['name'] for c in sa.inspect(op.get_bind()).get_columns('run_metadata')}


def upgrade():
    # Add only what is missing. The columns can already be there while the
    # revision stamp still says otherwise — two servers starting at once, or a
    # manual upgrade overlapping the one main.py runs at startup. Re-adding a
    # column then fails with "duplicate column name" and leaves the stamp behind
    # for good, so the same error repeats on every start.
    #
    # Nullable throughout: runs recorded before this migration have no snapshot.
    existing = _existing_columns()
    missing = [factory for name, factory in NEW_COLUMNS if name not in existing]
    if not missing:
        return
    with op.batch_alter_table('run_metadata', schema=None) as batch_op:
        for factory in missing:
            batch_op.add_column(factory())


def downgrade():
    existing = _existing_columns()
    present = [name for name, _ in reversed(NEW_COLUMNS) if name in existing]
    if not present:
        return
    with op.batch_alter_table('run_metadata', schema=None) as batch_op:
        for name in present:
            batch_op.drop_column(name)
