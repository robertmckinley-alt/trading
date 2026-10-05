#!/usr/bin/env python3
"""Frozen candidate, not a profitability claim. No LLM, broker keys or orders."""
import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
import numpy as np
from hmmlearn.hmm import GaussianHMM
from sklearn.preprocessing import StandardScaler


def segments(rows):
    stamps = [datetime.fromisoformat(r['availableAt'].replace('Z', '+00:00')).timestamp() for r in rows]
    boundaries = [0] + [i for i in range(1, len(rows)) if stamps[i] - stamps[i-1] != 60] + [len(rows)]
    return [b-a for a, b in zip(boundaries, boundaries[1:])]


def train(payload):
    rows = payload['rows']
    # Reserve complete dates, not random overlapping candles. Last 20% remains
    # sealed: it is never used for fitting, selection, thresholds or a score.
    days = sorted(set(r['availableAt'][:10] for r in rows))
    if len(days) < 60 or len(rows) < 10000:
        raise ValueError('Need at least 60 dates and 10,000 complete causal feature rows')
    a, b = days[int(len(days)*.6)], days[int(len(days)*.8)]
    training = [r for r in rows if r['availableAt'][:10] < a]
    validation = [r for r in rows if a <= r['availableAt'][:10] < b]
    sealed = [r for r in rows if r['availableAt'][:10] >= b]
    scaler = StandardScaler().fit(np.array([r['x'] for r in training]))
    x = scaler.transform([r['x'] for r in training])
    v = scaler.transform([r['x'] for r in validation])
    candidates = []
    for k in range(2, 6):
        fitted = []
        for seed in (17, 31, 53):
            model = GaussianHMM(n_components=k, covariance_type='diag', n_iter=100,
                                tol=.01, min_covar=1e-4, random_state=seed)
            try:
                model.fit(x, lengths=segments(training))
                history = list(model.monitor_.history)
                # hmmlearn also calls hitting n_iter "converged"; require an
                # actual likelihood plateau, allowing tiny numerical noise only.
                if len(history) < 2 or not (-1e-3 <= history[-1]-history[-2] < model.tol):
                    continue
                score = float(model.score(x, lengths=segments(training)))
                if np.isfinite(score):
                    fitted.append((score, model, seed))
            except (ValueError, FloatingPointError):
                continue
        if not fitted:
            continue
        _, model, seed = max(fitted, key=lambda item: item[0])
        # score() is sequence observation likelihood, not smoothed state labels.
        ll = float(model.score(v, lengths=segments(validation))) / len(v)
        bic = float(model.bic(x, lengths=segments(training)))
        if np.isfinite(ll) and np.isfinite(bic):
            candidates.append((ll, bic, k, model, seed))
    if not candidates:
        raise ValueError('No finite converged HMM candidate')
    best_ll = max(c[0] for c in candidates)
    # Prefer fewer states if predictive log likelihood differs by <= .01 per row.
    chosen = min((c for c in candidates if c[0] >= best_ll-.01), key=lambda c: (c[2], c[1]))
    ll, bic, k, model, seed = chosen
    raw_means = scaler.inverse_transform(model.means_)
    high_vol = float(np.quantile([r['x'][1] for r in training], .9))
    labels = ['high-volatility' if m[1] > high_vol else 'trend-up' if m[4] > 1 else 'trend-down' if m[4] < -1 else 'range' for m in raw_means]
    return dict(version='regime-v1', symbol='NQ', features=payload['features'],
                trainedThrough=training[-1]['availableAt'], usableAfter=validation[-1]['availableAt'],
                createdAt=datetime.now(timezone.utc).isoformat(),
                scaler=dict(mean=scaler.mean_.tolist(), scale=scaler.scale_.tolist()),
                start=model.startprob_.tolist(), transition=model.transmat_.tolist(),
                means=model.means_.tolist(), variances=model._covars_.tolist(), labels=labels,
                highVolatility=high_vol, seed=seed,
                evidence=dict(status='unvalidated-paper-candidate', trainingRows=len(training),
                              validationRows=len(validation), sealedRows=len(sealed),
                              sealedStart=sealed[0]['availableAt'], sealedEnd=sealed[-1]['availableAt'],
                              sealedChecksum=hashlib.sha256(json.dumps(sealed, sort_keys=True).encode()).hexdigest(),
                              sourceChecksum=payload['sourceChecksum'],
                              validationLogLikelihoodPerRow=ll, trainingBic=bic,
                              candidates=[dict(states=c[2], validationLogLikelihoodPerRow=c[0], trainingBic=c[1]) for c in candidates],
                              note='No strategy backtest performed. Sealed data unscored. Forward paper evidence required.'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('input')
    parser.add_argument('output')
    args = parser.parse_args()
    with open(args.input) as f:
        result = train(json.load(f))
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    # Never overwrite a frozen experiment model, including under concurrent fits.
    with open(args.output, 'x') as f:
        json.dump(result, f, allow_nan=False)
    print('Unvalidated paper candidate written:', args.output)
