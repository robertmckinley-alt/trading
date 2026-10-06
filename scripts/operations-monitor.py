#!/usr/bin/env python3
"""Read-only public endpoint monitor. Run on the HOST, independent of Docker."""
import argparse
import hashlib
import json
import os
import time
import urllib.request
from datetime import datetime
from pathlib import Path

URLS = {
    'futures': 'https://trading-eight-self.vercel.app/api/live-status',
    'crypto': 'https://i-x20-zeta.vercel.app/api/dashboard',
    'tap': 'https://i-x20-zeta.vercel.app/api/tap',
    'flow': 'https://i-x20-zeta.vercel.app/api/crypto-flow',
}

def stamp(value):
    try:
        if isinstance(value, (int, float)):
            return value / 1000 if value > 1e11 else value
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError, AttributeError):
        return 0

def evaluate(data, now):
    issues = {}
    def stale(value, seconds):
        at = stamp(value)
        return not at or now - at > seconds or at - now > 60
    def add(code, detail):
        issues[code] = detail
    for key in URLS:
        if key not in data:
            add(key + ':unavailable', key + ' endpoint unavailable or returned invalid data')
    f = data.get('futures')
    if f is not None:
        if not f.get('ok') or not f.get('strategies'):
            add('futures:invalid', 'Futures snapshot is empty or unsuccessful')
        if f.get('source') not in ('remote-bridge', 'remote-bridge-cache'):
            add('futures:fallback', 'Dashboard is not using the live VPS bridge')
        if stale(f.get('generatedAt'), 300):
            add('futures:snapshot', 'Futures snapshot is older than five minutes')
        closed = f.get('orbForward', {}).get('feed', {}).get('regularMarketClosed') is True
        for s in f.get('strategies', []):
            name = s.get('name', s.get('slug', 'unknown'))
            key = 'futures:' + s.get('slug', name)
            w, live = s.get('watcher', {}), s.get('live', {})
            if w.get('processCount') != 1:
                add(key + ':process', name + ': missing or duplicate watcher')
            if stale(w.get('lastHeartbeatAt'), 300):
                add(key + ':heartbeat', name + ': heartbeat older than five minutes')
            if not closed and stale((live.get('lastCandle') or {}).get('timestamp'), 300):
                add(key + ':feed', name + ': stale market candles')
            if live.get('latestError') and not live.get('recoveredFromError'):
                add(key + ':error', name + ': current runtime error (inspect watcher log)')
        for name, report, field in [
            ('coordination', f.get('coordinationShadow', {}), 'updatedAt'),
            ('orb', f.get('orbForward', {}), 'heartbeat'),
        ]:
            if stale(report.get(field), 300):
                add('futures:' + name, name + ' worker is missing or stale')
        regime = f.get('regimeExperiment', {})
        if regime.get('status') in ('not-started', 'awaiting-trained-model', 'error') or stale(regime.get('updatedAt'), 300):
            add('futures:regime', 'HMM experiment is not operational (training, error, or stale worker)')
        profit = f.get('profitExperiment', {})
        if profit.get('enabled') and (profit.get('status') in ('error', 'data-gap') or stale(profit.get('updatedAt'), 300) or (not closed and profit.get('status') == 'waiting-for-fresh-feed')):
            add('futures:profit-protection', 'Profit preservation paper worker has stale data, an error, or a missing heartbeat')
        risk = f.get('portfolioRisk', {})
        if risk.get('reservedRiskUsd', 0) > risk.get('capUsd', float('inf')) + .01:
            add('futures:risk', 'Reserved futures risk exceeds configured portfolio cap')
    c = data.get('crypto')
    if c is not None:
        if c.get('paperOnly') is not True or not c.get('books'):
            add('crypto:invalid', 'Crypto dashboard response is invalid or not paper-only')
        if stale(c.get('now'), 300):
            add('crypto:snapshot', 'Crypto snapshot is stale')
        runs = c.get('automation', {}).get('status', [])
        for book in ('large', 'meme'):
            for kind, age in [('mark', 300), ('entry', 900)]:
                relevant = [r for r in runs if r.get('book') == book and r.get('runType') == kind]
                latest = max(relevant, key=lambda r: stamp(r.get('startedAt')), default={})
                if stale(latest.get('completedAt'), age) or latest.get('status') != 'succeeded':
                    add(f'crypto:{book}:{kind}', f'{book} {kind} job is stale, failed, or missing from telemetry')
            for p in c.get('books', {}).get(book, {}).get('positions', []):
                if p.get('status') == 'open' and stale(p.get('lastMarkedAt'), 300):
                    add(f'crypto:{book}:mark:{p.get("id")}', f'{book}: an open position has stale price marks')
        poly = c.get('externalSources', {}).get('polymarketPaper', {}).get('latestRun') or {}
        if stale(poly.get('completedAt'), 900) or poly.get('status') != 'succeeded':
            add('crypto:polymarket', 'Polymarket paper job is stale or failed')
    tap = data.get('tap')
    if tap is not None:
        accounts = tap.get('accounts', [])
        if len(accounts) != 4:
            add('tap:accounts', 'Expected four TAP accounts')
        for account in accounts:
            if stale(account.get('lastRun'), 300):
                add('tap:' + account.get('name', 'unknown'), 'TAP worker is stale')
    flow = data.get('flow')
    if flow is not None and stale((flow.get('account') or {}).get('lastRun'), 300):
        add('flow:worker', 'Crypto Flow worker is stale')
    return issues

def fetch_json(url, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'Trading-Operations-Monitor/1.0'})
    with urllib.request.urlopen(request, timeout=25) as response:
        if response.status != 200:
            raise ValueError('HTTP failure')
        return json.loads(response.read(8_000_000))

def send(config, message):
    body = {'chat_id': config['chatId'], 'text': message[:4000], 'disable_web_page_preview': True}
    if config.get('messageThreadId'):
        body['message_thread_id'] = int(config['messageThreadId'])
    # Never log exceptions containing the Telegram URL, which contains the token.
    result = fetch_json('https://api.telegram.org/bot' + config['botToken'] + '/sendMessage', body)
    if result.get('ok') is not True:
        raise ValueError('Telegram rejected alert')

def should_notify(prior, issues, now):
    fingerprint = hashlib.sha256(json.dumps(sorted(issues)).encode()).hexdigest()
    changed = fingerprint != prior.get('fingerprint')
    return fingerprint, (bool(issues) and (changed or now - prior.get('sentAt', 0) >= 3600)) or (not issues and bool(prior.get('issues')))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='/etc/trading-monitor/config.json')
    parser.add_argument('--state', default='/var/lib/trading-monitor/state.json')
    parser.add_argument('--test-alert', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    now, data = time.time(), {}
    for key, url in URLS.items():
        try:
            result = fetch_json(url)
            if not isinstance(result, dict):
                raise ValueError('Not a JSON object')
            data[key] = result
        except Exception:
            pass  # evaluate() reports failed sources; no secret URLs in output.
    try:
        issues = evaluate(data, now)
    except Exception:
        issues = {'monitor:schema': 'Monitor could not evaluate endpoint schema; monitoring coverage is impaired'}
    path = Path(args.state)
    try:
        prior = json.loads(path.read_text())
    except (OSError, ValueError):
        prior = {}
    fingerprint, notify = should_notify(prior, issues, now)
    print(json.dumps({'checkedAt': now, 'status': 'attention' if issues else 'healthy', 'issues': issues}), flush=True)
    if args.dry_run:
        return
    sent_at = prior.get('sentAt', 0)
    if notify or args.test_alert:
        config = json.loads(Path(args.config).read_text())
        prefix = 'Trading monitor test: delivery is working.\n' if args.test_alert else ''
        message = prefix + ('ATTENTION\n' + '\n'.join('- ' + text for text in issues.values()) if issues else 'RECOVERED: all configured operational checks pass.')
        message += '\nChecks cover operations, not strategy profitability or live-trading certification.'
        try:
            send(config, message)
        except Exception:
            print('ALERT DELIVERY FAILED: check Telegram configuration and network. State not acknowledged.', flush=True)
            raise SystemExit(1)
        sent_at = now
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps({'checkedAt': now, 'fingerprint': fingerprint, 'issues': issues, 'sentAt': sent_at}))
    os.replace(temp, path)

if __name__ == '__main__':
    main()
