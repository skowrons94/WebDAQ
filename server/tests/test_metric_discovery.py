"""
"Add metric" lists what is alive: metrics with a value in the last hour, with
the latest one, and not the DAQ's own counting rates.
"""

import unittest
from datetime import datetime

from app.services import metric_discovery as D


class FakeGraphite:
    base_url = "http://graphite"

    def __init__(self):
        self.tree = {
            "": [("accelerator", False), ("ancillary", False), ("old_probe", True), ("carbon", False)],
            "carbon": [("carbon.agents", False)],
            "carbon.agents": [("carbon.agents.a.cpuUsage", True)],
            "accelerator": [("accelerator.terminal_voltage", True), ("accelerator.beam", False)],
            "accelerator.beam": [("accelerator.beam.current", True)],
            "ancillary": [("ancillary.rates", False), ("ancillary.vacuum", True)],
            "ancillary.rates": [("ancillary.rates.bo_0", False)],
        }
        self.last = {"accelerator.terminal_voltage": 400.0, "accelerator.beam.current": 12.5,
                     "ancillary.vacuum": 2e-7, "old_probe": None}
        self.render_calls = []

    def find_metrics(self, query):
        branch = "" if query == "*" else query[:-2]
        return [{"path": p, "is_leaf": leaf} for p, leaf in self.tree.get(branch, [])]

    def get_multiple_targets(self, targets, window):
        self.render_calls.append(list(targets))
        now = datetime(2026, 10, 22, 9, 0)
        return {t: [(now, None), (now, self.last.get(t))] for t in targets}


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        D._cache.update(at=0.0, key=None, result=None)

    def test_alive_metrics_only_without_our_rates(self):
        g = FakeGraphite()
        r = D.recent_metrics(g, ["ancillary.rates"])
        paths = [m["path"] for m in r["metrics"]]
        self.assertEqual(paths, ["accelerator.beam.current", "accelerator.terminal_voltage",
                                 "ancillary.vacuum"])
        self.assertNotIn("old_probe", paths)                  # nothing in the last hour
        self.assertFalse(any("rates" in p or p.startswith("carbon") for c in g.render_calls for p in c))
        self.assertEqual(r["metrics"][0]["value"], 12.5)

    def test_cached_for_a_minute(self):
        g = FakeGraphite()
        D.recent_metrics(g, ["ancillary.rates"])
        D.recent_metrics(g, ["ancillary.rates"])
        self.assertEqual(len(g.render_calls), 1)
        D.recent_metrics(g, ["ancillary.rates"], refresh=True)
        self.assertEqual(len(g.render_calls), 2)


if __name__ == "__main__":
    unittest.main()
