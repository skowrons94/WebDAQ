# Server tests

Plain `unittest` — no extra packages to install. Everything runs without CAEN
hardware, without a picoammeter and without a Graphite or ELOG server: the tests
either use `TEST_FLAG=True` (which substitutes the simulated digitizer and
picoammeter) or fake the HTTP responses.

Run them from the `server/` directory, with the `luna` environment active:

```bash
cd server
./tests/run_tests.sh              # everything
./tests/run_tests.sh safe         # only files matching *safe*
python -m unittest tests.test_routes -v    # one module
python -m unittest tests.test_routes.OnlineTuningRouteTests.test_a_safe_register_is_saved_and_written
```

`run_tests.sh` runs in a scratch directory so the suite never touches the
`conf/` and `data/` of a real setup — except `tests/test_routes.py`, which
drives the app the way the frontend does and therefore reads the working
directory it is started from.

## What each file covers

| File | Covers |
|------|--------|
| `test_safe_registers.py` | Which registers may be written to a live board, per firmware and per channel |
| `test_board_scanner.py` | Firmware decoding, VME range limits, scan lifecycle (progress, cancel, refusals) |
| `test_stats_file.py` | Metric names/units in `conf/stats.json`, and the CSV a run writes |
| `test_charge_accumulation.py` | Run charge integrates only during a run; total always |
| `test_graphite_client.py` | Both `/metrics/find` response shapes, and what counts as "reachable" |
| `test_elog_client.py` | Settings persistence, password masking, attachment host guard |
| `test_routes.py` | HTTP status codes and messages the frontend relies on |

## Adding a test

Test the rule, not the implementation: "a structural register is refused mid-run"
survives a refactor, "`_STRUCTURAL` has 16 entries" does not. Anything involving
the boards belongs behind `TEST_FLAG=True`.
