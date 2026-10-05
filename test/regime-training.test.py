"""Run explicitly with python3 test/regime-training.test.py."""
import importlib.util
import json
import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
import numpy as np
from hmmlearn.hmm import GaussianHMM

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('trainer', ROOT / 'scripts/train-regime-model.py')
trainer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trainer)


class RegimeTrainingTests(unittest.TestCase):
    def test_node_forward_filter_matches_hmmlearn_prefix_only_posteriors(self):
        rng = np.random.default_rng(17)
        x = np.vstack([rng.normal(-1, .2, (60, 5)), rng.normal(1, .3, (60, 5))])
        fitted = GaussianHMM(n_components=2, covariance_type='diag', random_state=17, n_iter=30).fit(x)
        f = dict(means=fitted.means_.tolist(), variances=fitted._covars_.tolist(),
                 start=fitted.startprob_.tolist(), transition=fitted.transmat_.tolist(),
                 scaler=dict(mean=[0]*5, scale=[1]*5))
        code = "const m=require('./lib/regime-model.cjs');let input=JSON.parse(require('fs').readFileSync(0,'utf8')),p=null;console.log(JSON.stringify(input.x.map(x=>{p=m.step(input.model,x,p).probabilities;return p;})));"
        result = subprocess.run(['node', '-e', code], cwd=ROOT, input=json.dumps(dict(model=f, x=x.tolist())), text=True, capture_output=True, check=True)
        probabilities = np.array(json.loads(result.stdout))
        # Only last posterior of each prefix is filtered; earlier prefix rows are smoothed.
        expected = np.array([fitted.predict_proba(x[:i+1])[-1] for i in range(len(x))])
        np.testing.assert_allclose(probabilities, expected, atol=1e-10)

    def test_training_does_not_touch_sealed_values(self):
        rng = np.random.default_rng(31)
        rows = []
        for day in range(60):
            begin = datetime(2026, 1, 1, tzinfo=timezone.utc)+timedelta(days=day, hours=14)
            for minute in range(180):
                state = (minute // 30) % 2
                x = rng.normal(0, .1, 5)
                x[1] = .1 + state*.1 + abs(x[1])
                x[4] += 2 if state else -2
                rows.append(dict(availableAt=(begin+timedelta(minutes=minute)).isoformat(), x=x.tolist()))
        payload = dict(features=['logReturn','volatility','range','volumeRatio','trend'], rows=rows, sourceChecksum='fixture')
        first = trainer.train(payload)
        for row in rows[48*180:]:
            row['x'] = [999999]*5
        second = trainer.train(payload)
        for field in ['scaler','start','transition','means','variances','labels','highVolatility','trainedThrough','usableAfter','seed']:
            self.assertEqual(first[field], second[field], field)
        self.assertNotEqual(first['evidence']['sealedChecksum'], second['evidence']['sealedChecksum'])
        self.assertEqual(first['evidence']['validationLogLikelihoodPerRow'], second['evidence']['validationLogLikelihoodPerRow'])


if __name__ == '__main__':
    unittest.main()
