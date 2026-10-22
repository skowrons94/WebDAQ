"""
The monitoring servers as one setting, and finding them.

Three things are pinned down here:

  * detection reports what really answers, gives up within its deadline, and
    does not take WebDAQ's own frontend (port 3000 here) for a Grafana;
  * the beam current goes to the Carbon port of the one Graphite server in
    conf/stats.json, and follows it when it changes;
  * an older conf/current.json with its own Graphite address is reported, not
    silently dropped, and not rewritten.

No network is used: the probes are replaced, or pointed at fakes.
"""

import json
import os
import shutil
import tempfile
import time
import unittest
from unittest import mock

os.environ.setdefault('TEST_FLAG', 'True')

from app.services import monitoring  # noqa: E402
from app.utils.graphite import answers_like_graphite  # noqa: E402


def _response(status=200, body=None, text=None):
    r = mock.Mock()
    r.status_code = status
    if body is not None:
        r.json.return_value = body
    else:
        r.json.side_effect = ValueError('not JSON')
    r.text = text or ''
    return r


class InTempConf(unittest.TestCase):
    """A scratch working directory with its own conf/."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-monitoring-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        os.makedirs('conf')
        # The Carbon target is cached by the file's mtime; start each test fresh.
        monitoring._cache['mtime'] = object()
        monitoring._legacy_warned = False

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)
        monitoring._cache['mtime'] = object()

    def write(self, name, data):
        path = os.path.join('conf', name)
        with open(path, 'w') as f:
            json.dump(data, f)
        # A distinct mtime even when two writes land in the same tick.
        stamp = time.time() + getattr(self, '_bump', 0)
        self._bump = getattr(self, '_bump', 0) + 1
        os.utime(path, (stamp, stamp))


class AnswerRecognitionTests(unittest.TestCase):
    def test_a_json_list_is_graphite(self):
        self.assertTrue(answers_like_graphite(_response(body=[{'path': 'carbon'}])))

    def test_html_or_an_object_is_not(self):
        self.assertFalse(answers_like_graphite(_response(text='<!DOCTYPE html>')))
        self.assertFalse(answers_like_graphite(_response(body={'database': 'ok'})))
        self.assertFalse(answers_like_graphite(_response(status=404, body=[])))

    def test_grafana_is_told_apart_from_the_webdaq_frontend(self):
        # WebDAQ's Next.js frontend answers /api/health with an HTML page.
        with mock.patch.object(monitoring.requests, 'get',
                               return_value=_response(text='<!DOCTYPE html><html>')):
            self.assertIsNone(monitoring._probe_grafana('127.0.0.1', 3000))
        with mock.patch.object(monitoring.requests, 'get',
                               return_value=_response(body={'database': 'ok', 'version': '11.2.2'})):
            self.assertEqual(monitoring._probe_grafana('127.0.0.1', 3001),
                             {'version': '11.2.2', 'database': 'ok'})
        # Some other JSON API on a Grafana port is not Grafana either.
        with mock.patch.object(monitoring.requests, 'get',
                               return_value=_response(body={'status': 'ok'})):
            self.assertIsNone(monitoring._probe_grafana('127.0.0.1', 3002))


class DetectTests(unittest.TestCase):
    """detect() with the network replaced by a table of what answers."""

    def run_detect(self, graphite=(), carbon=(), grafana=None, names=None, **kwargs):
        names = names if names is not None else {'localhost': '127.0.0.1'}
        grafana = grafana or {}
        with mock.patch.object(monitoring, '_resolve', side_effect=lambda h: names.get(h)), \
             mock.patch.object(monitoring, '_probe_graphite',
                               side_effect=lambda a, p: (a, p) in graphite), \
             mock.patch.object(monitoring, '_probe_carbon',
                               side_effect=lambda a, p: (a, p) in carbon), \
             mock.patch.object(monitoring, '_probe_grafana',
                               side_effect=lambda a, p: grafana.get((a, p))):
            return monitoring.detect(**kwargs)

    def test_the_local_docker_stack_is_found(self):
        # scripts/monitoring.sh: Graphite web on 8080, Carbon 2003, Grafana 3001.
        result = self.run_detect(
            graphite={('127.0.0.1', 8080)}, carbon={('127.0.0.1', 2003)},
            grafana={('127.0.0.1', 3001): {'version': '11.2.2', 'database': 'ok'}},
            hosts=['localhost', 'lunaserver'])
        self.assertEqual(result['graphite'],
                         [{'host': 'localhost', 'web_port': 8080, 'carbon_port': 2003}])
        self.assertEqual(result['grafana'],
                         [{'url': 'http://localhost:3001', 'version': '11.2.2', 'database': 'ok'}])
        self.assertEqual(result['unresolved'], ['lunaserver'])

    def test_a_configured_odd_port_is_tried(self):
        result = self.run_detect(graphite={('127.0.0.1', 9999)}, hosts=['localhost'],
                                 graphite_ports=[9999])
        self.assertEqual(result['graphite'][0]['web_port'], 9999)
        self.assertIsNone(result['graphite'][0]['carbon_port'])

    def test_two_names_for_one_machine_report_it_once(self):
        result = self.run_detect(
            graphite={('127.0.0.1', 80)}, carbon={('127.0.0.1', 2003)},
            names={'localhost': '127.0.0.1', 'daqpc': '127.0.0.1'},
            hosts=['daqpc', 'localhost', 'localhost', ''])
        self.assertEqual(result['hosts'], ['daqpc', 'localhost'])
        self.assertEqual([g['host'] for g in result['graphite']], ['daqpc'])

    def test_carbon_alone_is_reported_only_for_the_configured_host(self):
        names = {'localhost': '127.0.0.1', 'collector': '10.0.0.5'}
        carbon = {('127.0.0.1', 2003), ('10.0.0.5', 2003)}
        result = self.run_detect(carbon=carbon, names=names,
                                 hosts=['collector', 'localhost'], carbon_hosts=['collector'])
        self.assertEqual(result['graphite'],
                         [{'host': 'collector', 'web_port': None, 'carbon_port': 2003}])

    def test_nothing_found_is_an_empty_answer(self):
        result = self.run_detect(hosts=['localhost'])
        self.assertEqual((result['graphite'], result['grafana']), ([], []))

    def test_a_host_that_never_answers_does_not_hold_up_the_answer(self):
        def stuck(address, port):
            time.sleep(3)
            return False

        with mock.patch.object(monitoring, 'DETECT_DEADLINE_S', 0.5), \
             mock.patch.object(monitoring, '_resolve', return_value='10.9.9.9'), \
             mock.patch.object(monitoring, '_probe_graphite', side_effect=stuck), \
             mock.patch.object(monitoring, '_probe_carbon', side_effect=stuck), \
             mock.patch.object(monitoring, '_probe_grafana', side_effect=stuck):
            started = time.monotonic()
            result = monitoring.detect(['blackhole'])
            elapsed = time.monotonic() - started
        self.assertLess(elapsed, 1.5)
        self.assertEqual(result['graphite'], [])

    def test_a_name_that_never_resolves_does_not_hold_up_the_answer(self):
        def slow_resolve(host):
            if host == 'stuck-dns':
                time.sleep(3)
                return None
            return '127.0.0.1'

        with mock.patch.object(monitoring, '_resolve', side_effect=slow_resolve), \
             mock.patch.object(monitoring, '_RESOLVE_DEADLINE_S', 0.3), \
             mock.patch.object(monitoring, '_probe_graphite', return_value=False), \
             mock.patch.object(monitoring, '_probe_carbon', return_value=False), \
             mock.patch.object(monitoring, '_probe_grafana', return_value=None):
            started = time.monotonic()
            result = monitoring.detect(['stuck-dns', 'localhost'])
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(result['unresolved'], ['stuck-dns'])

    def test_url_helpers(self):
        self.assertEqual(monitoring.host_of_url('http://lunaserver:3000'), 'lunaserver')
        self.assertEqual(monitoring.host_of_url('lunaserver:3000'), 'lunaserver')
        self.assertEqual(monitoring.host_of_url(''), '')
        self.assertEqual(monitoring.port_of_url('http://lunaserver:3001'), 3001)
        self.assertEqual(monitoring.port_of_url('https://grafana.lngs.infn.it'), 443)


class CarbonTargetTests(InTempConf):
    def test_it_is_the_graphite_host_and_carbon_port(self):
        self.write('stats.json', {'graphite_host': 'lunaserver', 'graphite_port': 80,
                                  'carbon_port': 2013})
        self.assertEqual(monitoring.carbon_target(), ('lunaserver', 2013))

    def test_carbon_port_defaults_to_2003(self):
        self.write('stats.json', {'graphite_host': 'lunaserver', 'graphite_port': 8080})
        self.assertEqual(monitoring.carbon_target(), ('lunaserver', 2003))

    def test_a_change_to_the_file_is_followed(self):
        self.write('stats.json', {'graphite_host': 'old', 'carbon_port': 2003})
        self.assertEqual(monitoring.carbon_target(), ('old', 2003))
        self.write('stats.json', {'graphite_host': 'new', 'carbon_port': 2004})
        self.assertEqual(monitoring.carbon_target(), ('new', 2004))

    def test_no_file_means_no_push(self):
        self.assertEqual(monitoring.carbon_target(), ('', 2003))


class CurrentModuleUsesTheOneServerTests(InTempConf):
    """The picoammeters push where conf/stats.json says, not where they were built to."""

    def pushed_to(self, controller):
        sent = []
        with mock.patch.object(controller._carbon, 'send',
                               side_effect=lambda h, p, m, t: sent.append((h, p)) or True):
            controller._push_metrics([('rbd9103.current', 1.0)], time.time())
        return sent[-1]

    def test_tetramm_and_rbd9103_follow_the_monitoring_setting(self):
        from app.utils.tetramm import TetrAMMController
        from app.utils.rbd9103 import RBD9103Controller
        from app.routes.current import _push_to_monitoring

        self.write('stats.json', {'graphite_host': 'lunaserver', 'graphite_port': 80,
                                  'carbon_port': 2003})
        for controller in (TetrAMMController(graphite_host='172.18.9.54', graphite_port=2003),
                           RBD9103Controller(graphite_host='localhost', graphite_port=2003)):
            _push_to_monitoring(controller)
            self.assertEqual(self.pushed_to(controller), ('lunaserver', 2003))
            # Moving the server in Settings → Monitoring moves the current with it.
            self.write('stats.json', {'graphite_host': 'localhost', 'graphite_port': 8080,
                                      'carbon_port': 2004})
            self.assertEqual(self.pushed_to(controller), ('localhost', 2004))
            self.write('stats.json', {'graphite_host': 'lunaserver', 'graphite_port': 80,
                                      'carbon_port': 2003})

    def test_a_controller_on_its_own_keeps_its_own_address(self):
        from app.utils.tetramm import TetrAMMController
        controller = TetrAMMController(graphite_host='10.1.1.1', graphite_port=2003)
        self.assertEqual(self.pushed_to(controller), ('10.1.1.1', 2003))


class LegacyCurrentAddressTests(InTempConf):
    OLD = {'module_type': 'tetramm', 'graphite_host': '172.18.9.54', 'graphite_port': 2003}

    def test_a_different_old_address_is_reported(self):
        self.write('stats.json', {'graphite_host': 'localhost', 'carbon_port': 2003})
        self.assertEqual(monitoring.legacy_current_target(self.OLD),
                         {'host': '172.18.9.54', 'port': 2003})

    def test_the_same_address_is_not_news(self):
        self.write('stats.json', {'graphite_host': '172.18.9.54', 'carbon_port': 2003})
        self.assertIsNone(monitoring.legacy_current_target(self.OLD))

    def test_no_old_address_is_not_news(self):
        self.write('stats.json', {'graphite_host': 'localhost'})
        self.assertIsNone(monitoring.legacy_current_target({'module_type': 'rbd9103'}))

    def test_it_is_logged_once_and_the_file_is_left_alone(self):
        self.write('stats.json', {'graphite_host': 'localhost', 'carbon_port': 2003})
        self.write('current.json', self.OLD)
        with open('conf/current.json') as f:
            before = f.read()
        with self.assertLogs('app.services.monitoring', level='WARNING') as logs:
            monitoring.warn_legacy_current_target(dict(self.OLD))
            monitoring.warn_legacy_current_target(dict(self.OLD))
        self.assertEqual(len(logs.output), 1)
        self.assertIn('172.18.9.54:2003', logs.output[0])
        self.assertIn('localhost:2003', logs.output[0])
        with open('conf/current.json') as f:
            self.assertEqual(f.read(), before)


class MonitoringRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from app import create_app
        from app.utils.jwt_utils import generate_token
        cls.app = create_app()
        with cls.app.app_context():
            cls.token = generate_token(1)
        cls.client = cls.app.test_client()
        cls.auth = {'Authorization': f'Bearer {cls.token}'}

    def test_detect_and_status_need_a_token(self):
        for url in ('/monitoring/detect', '/monitoring/status'):
            self.assertEqual(self.client.get(url).status_code, 401, url)

    def test_detect_asks_about_the_known_hosts(self):
        found = {'graphite': [], 'grafana': [], 'hosts': [], 'unresolved': [], 'elapsed_s': 0.1}
        with mock.patch.object(monitoring, 'detect', return_value=found) as detect:
            response = self.client.get('/monitoring/detect', headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), found)
        hosts = detect.call_args.args[0]
        self.assertIn('localhost', hosts)
        self.assertIn('lunaserver', hosts)

    def test_the_current_module_no_longer_takes_its_own_address(self):
        response = self.client.post('/current/graphite_config', headers=self.auth,
                                    json={'graphite_host': 'x', 'graphite_port': 2003})
        self.assertEqual(response.status_code, 410)
        body = self.client.get('/current/graphite_config', headers=self.auth).get_json()
        self.assertEqual((body['graphite_host'], body['graphite_port']), monitoring.carbon_target())
        self.assertIn('legacy', body)


if __name__ == '__main__':
    unittest.main()
