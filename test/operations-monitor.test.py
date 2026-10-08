import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('monitor', Path(__file__).resolve().parents[1] / 'scripts/operations-monitor.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class MonitorTests(unittest.TestCase):
    def sample(self):
        now = 1791309600
        runs = [{'book': b, 'runType': k, 'status': 'succeeded', 'startedAt': now, 'completedAt': now} for b in ['large', 'meme'] for k in ['mark', 'entry']]
        return now, {
            'futures': {'ok': True, 'source': 'remote-bridge', 'generatedAt': now, 'strategies': [{'slug': 'test', 'watcher': {'processCount': 1, 'lastHeartbeatAt': now}, 'live': {'lastCandle': {'timestamp': now}}}], 'coordinationShadow': {'updatedAt': now}, 'orbForward': {'heartbeat': now, 'feed': {'regularMarketClosed': False}}, 'regimeExperiment': {'status': 'running', 'updatedAt': now}},
            'crypto': {'paperOnly': True, 'now': now, 'books': {'large': {}, 'meme': {}}, 'automation': {'status': runs}, 'externalSources': {'polymarketPaper': {'latestRun': {'completedAt': now, 'status': 'succeeded'}}}},
            'tap': {'accounts': [{'name': str(i), 'lastRun': now} for i in range(4)]},
            'flow': {'account': {'lastRun': now * 1000}},
        }
    def test_account_state_error_alerts(self):
        now, data = self.sample()
        data['futures']['portfolioRisk'] = {'status': 'state-error', 'issues': [{'reason': 'Unreadable account'}]}
        self.assertIn('futures:risk-state', m.evaluate(data, now))

    def test_healthy_and_market_closure(self):
        now, data = self.sample()
        self.assertEqual(m.evaluate(data, now), {})
        data['futures']['orbForward']['feed']['regularMarketClosed'] = True
        data['futures']['strategies'][0]['live']['lastCandle']['timestamp'] = now - 86400
        self.assertEqual(m.evaluate(data, now), {})
        data['futures']['strategies'][0]['watcher']['processCount'] = 0
        self.assertIn('futures:test:process', m.evaluate(data, now))
    def test_missing_endpoint_and_stale_worker(self):
        now, data = self.sample()
        del data['crypto']
        data['futures']['strategies'][0]['watcher']['lastHeartbeatAt'] = now - 301
        issues = m.evaluate(data, now)
        self.assertIn('crypto:unavailable', issues)
        self.assertIn('futures:test:heartbeat', issues)
    def test_failed_job_and_stale_open_position(self):
        now, data = self.sample()
        data['crypto']['automation']['status'][0]['status'] = 'degraded'
        data['crypto']['books']['large']['positions'] = [{'id': 'p', 'status': 'open', 'lastMarkedAt': now - 301}]
        issues = m.evaluate(data, now)
        self.assertIn('crypto:large:mark', issues)
        self.assertIn('crypto:large:mark:p', issues)
    def test_profit_worker_errors_and_stale_heartbeat(self):
        now, data = self.sample()
        data['futures']['profitExperiment'] = {'enabled': True, 'status': 'collecting', 'updatedAt': now}
        self.assertEqual(m.evaluate(data, now), {})
        data['futures']['profitExperiment']['status'] = 'data-gap'
        self.assertIn('futures:profit-protection', m.evaluate(data, now))
        data['futures']['profitExperiment'].update(status='collecting', updatedAt=now - 301)
        self.assertIn('futures:profit-protection', m.evaluate(data, now))
    def test_deduplication_hourly_reminder_and_recovery(self):
        issues = {'down': 'worker down'}
        fingerprint, notify = m.should_notify({}, issues, 10000)
        self.assertTrue(notify)
        prior = {'fingerprint': fingerprint, 'issues': issues, 'sentAt': 10000}
        self.assertFalse(m.should_notify(prior, issues, 10900)[1])
        self.assertTrue(m.should_notify(prior, issues, 13600)[1])
        self.assertTrue(m.should_notify(prior, {}, 10900)[1])
        self.assertFalse(m.should_notify({}, {}, 10000)[1])

if __name__ == '__main__':
    unittest.main()
