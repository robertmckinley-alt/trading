# Frozen market-regime paper experiment

## Repair an existing Docker-published status port

If the local API works but Docker forwards port 3210 to a container with a
loopback-only listener, run `node scripts/repair-bridge-binding.cjs` inside that
container. This explicitly enables `0.0.0.0` in `runtime/bridge-listener.json`,
keeps the existing mandatory bearer token, and restarts only the status service.
It verifies HTTP 401 without a token and account data with the token through the
container IPv4 interface. It does not modify trade journals or Docker/firewall
settings. The existing published port becomes reachable on its existing host
interfaces; retain the deployment's intended firewall/TLS controls. Other installs
still default to loopback. Removing the override and restarting restores loopback.

This is an unvalidated forward paper experiment, not a replacement for existing strategies.
It reads admitted parent plans and the NQ cache. It never modifies original accounts,
blocks their trades, reserves their portfolio risk, or submits broker orders.

Default parents: NQ 15-minute ORB close confirmation, EMA 20/60 momentum, and volume
POC reversion. Each receives four independent $50,000 accounts on its first eligible
signal: control, simple filter, HMM filter, HMM sizing. These do not enter main dashboard
totals. Existing parent balances/history are not copied into the new controls.

## Activate on the existing VPS

From the checkout inside the existing trading container:

```sh
git pull --ff-only origin main
bash scripts/setup-regime-paper.sh
```

Requires Python 3.11+ with venv/pip, Node, Linux, and the existing verified NQ historical
cache. The setup does not download or purchase historical candles. At least 60 dates
and 10,000 causal feature rows are required for fitting. This is only a numerical
minimum for a paper candidate, not evidence of market-cycle coverage or profitability.
If history is missing, setup stops without changing original trading accounts.
The model refuses overwrite. The status-server supervisor restarts an enabled worker.
Check `runtime/regime-experiment/report.json` for heartbeat/status. The frontend needs
the new status-server version to receive the experiment report.

## Model and evaluation boundaries

- Uses completed, contiguous, same-instrument minute bars. Features: log return,
  20-minute realized volatility, range/price, relative volume, 60-minute trend.
- Resets feature warmup at missing minutes and contract changes. Requires 61 bars.
- Chronological complete-date split: 60% training, 20% model selection, 20% sealed.
  The scaler and simple-filter volatility threshold use training rows only.
- Fits diagonal Gaussian HMMs with 2–5 states and three fixed initialization seeds.
  Chooses the best training likelihood seed per state count, then uses validation
  observation likelihood. Prefers fewer states within .01 log likelihood/row, with
  training BIC recorded. No profitability claims follow from that selection.
- Sealed final rows are fingerprinted but not scored or used to fit/refit. Do not
  repeatedly tune against them. Current release does NOT claim a walk-forward
  strategy backtest or untouched-period profitability test has passed.
- Live inference uses the forward recursion only. Predictions before the validation
  cutoff are prohibited. State needs 20 new feature rows after a reset. No Viterbi
  paths or smoothed historical posteriors are used for decisions.
- Model and rules are frozen per cohort. No nightly changes, auto-promotion, or
  Kelly sizing. A different model/risk configuration requires a new versioned
  experiment, with old journals retained for comparison.

## Frozen hypotheses

HMM labels describe emissions: high volatility if the state's mean volatility exceeds
the training 90th percentile; otherwise up/down trend if mean standardized trend is
above 1/below -1; otherwise range. Duplicate labels are allowed. No state is labeled
"crash" or claimed to forecast a crash. State probability is not trade win probability.

The simple filter uses the same volatility threshold and trend cutoffs on the current
feature row. HMM uncertainty means top probability below .70 or top-two margin below
.15. Breakout/momentum hypotheses accept direction-matching trends. Reversion accepts
range. The HMM sizing arm uses full risk when favorable and half otherwise. Unavailable
model/data causes the whole new cohort signal to be excluded, not treated as a saved loss.
These thresholds are preregistered hypotheses, not optimized or established advantages.

## Matched execution and limitations

- Only signals admitted by the original parent are copied. This evaluates incremental
  filtering/sizing of that stream; it does not evaluate previously rejected signals.
- All four arms receive the same worker observation time; fills start on a subsequent
  available minute boundary. There is no retrospective copying of the parent's fills.
  Old signals (over two minutes), pre-cohort signals and unwarmed decisions are excluded.
- Original stop/target prices and order deadlines are retained. Entry delays may make
  a copied order expire. The shared execution engine includes fees, slippage, conservative
  limit fills, stop-first ambiguity and integer contracts. Half risk may mean no contract.
- Each account uses fixed configured risk, the same static starting-balance drawdown
  floor as the current engine, and the parent's daily loss limit. Remaining daily loss
  room also limits new risk. Stop gaps can exceed planned risk. No unrealized trailing
  drawdown rule is implied. Reported drawdown is from observed marked equity.
- Execution paths persist across cache rotation/restarts. Missing minutes/rolls cause
  unresolved outcomes and block that account's new orders. Never invent a fill over gaps.
- Blocked-signal results resolve only when the matched control closes. Winning control
  trades count as missed profit; losing trades count as avoided losses. Risk rejections
  and unavailable observations are not attributed to the regime filter.
- Paired differences use terminal results on both sides (or an explicit regime block).
  Whole-account differences can have unmatched/open trades; do not confuse the two.
- Accounts have independent risk budgets; this does not simulate combined live portfolio
  capital, market impact or order competition. Review those separately before promotion.

## Operations and validation

Runtime settings, model, state, signal ledger, report and logs are under
`runtime/regime-experiment/`. Original files remain read-only. Keep this directory
backed up with existing VPS journals. Set `settings.json` enabled=false to pause the
worker, including settlement; resume it to continue. Pausing does not flatten positions.
There is no broker connectivity in this module.

```sh
node --test
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 python3 test/regime-training.test.py
npm run build -- --webpack
```

Tests cover causal features, prefix-filter parity with hmmlearn, sealed-data isolation,
future availability, identical observation timing, transaction costs, blocked winners
and losers, missing paths, independent loss caps, idempotency, restart recovery, and
frozen-model enforcement. Synthetic test fixtures are never production models/results.
