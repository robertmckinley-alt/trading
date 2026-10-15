# System repair and research release — October 15, 2026

## Verified operational evidence

The production futures API at 18:52:22 UTC reported remote-bridge data, 15/15 healthy watchers, fresh coordination/ORB heartbeats, collecting regime/profit workers, and clear portfolio-risk state. This verifies that snapshot, not continued uptime or profitability. The VPS DMC replay independently confirmed that the previous ATR rejected scheduled maintenance and the repaired ATR was valid. All 23 Market Open checks still failed other setup rules; no historical trades were created.

The separate crypto application has a confirmed Neon database quota outage (HTTP 402 in Vercel production logs). Cron runs, but journal reads/writes fail. Empty books are not evidence of no positions. Code now exposes storage failure explicitly; provider capacity must be restored separately, then existing positions reconciled. No billing change, database replacement, or balance reset is part of this release.

## Six research agents and repair scope

| Area | Concrete repair | What it does not establish |
|---|---|---|
| Execution | New limit plans need post-entry evidence for entry-bar targets; session expiry releases pending plans | This optimistic accounting defect did not cause all losses |
| Hard risk | VWAP/Gold must pass daily-loss and account-floor admission before fixed sizing | No claim that this bypass caused the audited week's losses |
| DMC/fresh retest | Require current completed M5, actual preopen H1, one contract, valid data, and uninterrupted break-to-retest observations | More valid signals or profitable signals are not guaranteed |
| Cache/monitoring | Gold uses its own schedule; invalid bars fail validation; missing cache days are visible; Gold outages cannot hide behind NQ closure | Missing historical files are not recovered by this patch |
| Research evidence | Forward-only results drive forward candidate gates; chronological splits are no longer called sealed holdouts | No automated promotion to funded trading |
| Crypto | Database errors become explicit HTTP 503 instead of apparently empty books | Neon quota remains an external blocker |

New intrabar accounting is versioned. Existing plans finish under their saved semantics and old journals remain intact. Regime/profit comparison accounts are separated by execution policy so old and new outcomes are not mixed. First-captured experiment configuration is immutable; polling cannot replace actual risk settings with generic settings.

## Ongoing paper research

Activation enables a separate `entry-research-v1-post-fill` state and report under `runtime/profit-experiment`. Each parent has independently accounted $50,000 paper arms:

- Matched control using the same prospective observation and new fill policy.
- Three-minute deadline measured from the original signal availability. An expired experimental arm is recorded as filtered while the control remains eligible.
- Actual fill must retain at least half the original structural stop distance.
- Requested stop must span at least one ATR of 14 completed one-minute true ranges, using valid contiguous history from one contract.

These are predeclared exploratory hypotheses, not thresholds optimized on this week's losses. All arms share the conservative matched quantity and independent risk limits. Only new admitted parent signals are captured. No historical backfill, extra baseline entries, paid data downloads, or funded orders. This cannot measure signals the parent never admitted. Accounts are created on eligible new observations, so an empty new research report can be normal.

Parents: 9AM sweep, VWAP, POC, hourly sweep, three ORB strategies, DMC failed-level, DMC gain/retest, and Fresh Retest. Existing exit-protection experiments remain separate. Gold entry experiments are excluded until their own feed is explicitly supported. EMA and HTF algorithms were not retuned; they receive shared correctness/risk fixes where applicable. NFL strategy logic was not part of this futures/crypto review.

The agents used for this audit are actual delegated research/code reviewers. The existing dashboard “research council” is a deterministic explanation panel, not six persistent autonomous AI researchers. Ongoing comparisons run in the existing paper worker; there is no claim of nightly AI strategy rewriting.

## Activation

On the VPS, pull main and run `bash scripts/activate-system-research.sh`. It backs up experiment settings, enables prospective entry research, restarts already-running strategy watchers while preserving plans and journals, reloads experiment workers, and restarts the status server. An in-progress backtest may restart. Update the host's monitor copy as well so the existing 15-minute cron sees per-symbol and entry-research checks.

Run the read-only historical cache diagnostic:

`node scripts/diagnose-historical-cache.cjs 2026-10-01T00:00:00Z 2026-10-15T00:00:00Z`

It reports missing, incomplete, corrupt, and unreviewed days. The rolling 4,800-candle live cache is separate. Resolving historical tail truncation requires this actual VPS evidence; no invented candles or silent shortening of the requested comparison window.

Verify fresh watcher heartbeats, entry-research report timestamps/status, retained account histories, and host monitor output after activation. A healthy monitor is evidence of operation, not an edge. Research improvements require matched terminal outcomes across new signals, costs, drawdowns, missed winners, and multiple market conditions. Current experiments are exploratory and not sealed out-of-sample validation.

See LOSS_AUDIT_2026-10-15.md, DMC_RESEARCH_AUDIT_2026-10-15.md, DATA_OPERATIONS_AUDIT_2026-10-15.md, SYSTEM_RESEARCH_REVIEW.md, and CRYPTO_HEALTH_REVIEW_2026-10-15.md for detailed evidence.
