# Crypto operations review — October 15, 2026

Observed 18:53–18:54 UTC (11:53–11:54 Pacific). Scope: Chaintape production public read endpoints, deployed-source metadata, and authenticated Vercel runtime logs. No orders, cron invocations, database mutations, billing changes, or balance resets were performed.

## Confirmed blocker

The Neon database rejects requests with HTTP 402 because the account or project has exceeded its quota. Production logs show the same provider error for the position marker, BTC laboratory, and Crypto Flow jobs every minute. Cron is invoking jobs; successful persisted operation is blocked by database capacity. This is not evidence of absent trading signals or deleted history.

Production deployment: `dpl_HHtG6NgGnnLPv538DpKu25GsfFud`, GitHub revision `17b36045d67d0cf86f1700c6e52790a781983f77`. Its recent Coinbase secondary-venue history fix must be preserved.

| Read endpoint | Observed response |
| --- | --- |
| `/api/health` | HTTP 200, `ok:false`; automation appears not started because database errors are swallowed |
| `/api/dashboard` | HTTP 200, both books have empty cycles/positions and null risk state |
| `/api/tap` | Storage unavailable, no accounts returned |
| `/api/crypto-flow` | Storage unavailable, no account/history returned |
| `/api/btc-lab` | HTTP 503, storage unavailable or invalid state |

Configured provider booleans only prove configuration exists, not that a provider is healthy. Public market data still loads while journals cannot be read. Current P&L, open positions, missed fills, and historical completeness cannot be verified during this outage.

## Prepared application correction

In the crypto checkout, a narrowly scoped patch makes health return HTTP 503 on failed checks, classifies the quota error without exposing connection strings, and prevents the main dashboard from silently representing failed journal reads as healthy empty books. Four regression tests pass and TypeScript checking passes. This does not restore Neon capacity and must not be described as fixing the outage. No strategy rules or accounting are changed.

## Required recovery and verification

1. Review Neon quota/billing for the existing production database and restore authorized capacity. The available evidence does not identify which quota dimension was exhausted. Do not replace the database or initialize fresh balances as a workaround.
2. After capacity is restored, confirm existing accounts and journals are readable, then let the scheduled jobs run. Verify fresh persisted timestamps for every worker, not only the latest successful job.
3. Reconcile positions that were open across the outage against available market history before treating marks or exits as reliable. Minute-by-minute processes did not persist successful updates during the confirmed blocked period.
4. Review database load: several workers run every minute; BTC research reads all saved hourly bars on each forward cycle, and Crypto Flow history aggregates the entire history for each dashboard request. Measure provider usage before changing cadence or retention. Do not delete audit history to reduce consumption.
5. The public health endpoint returning non-2xx must be included in an external monitor, so a database outage cannot masquerade as a quiet trading day.

The outage start time and trade impact remain unverified. The sampled logs establish repeated failure during the sampled period, not the duration of the entire incident.
