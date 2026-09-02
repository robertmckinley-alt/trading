# DoctorTrades Strategy Research Register

Updated: 2026-09-02

This register treats public strategy repositories as research leads, not proof that a strategy will make money. GitHub is unbounded and changes continuously, so an exhaustive review of “all repositories” is not possible. The first screening pass prioritizes NQ/futures relevance, explicit rules, reproducible tests, honest limitations, and a license that permits reuse.

All strategies in this application are paper-only. They share the same Databento Live OHLCV stream and the same account model: $50,000 starting balance per strategy, 10% drawdown floor, $500 maximum paper risk per trade, $750 daily loss guard, modeled commission and slippage, and one trade per strategy per day.

## Installed research network

| Strategy | Research basis | Implementation status | Important limitation |
| --- | --- | --- | --- |
| 9AM Asia/London Sweep | Original DoctorTrades rules | Existing baseline; independent paper account | Results are forward paper observations, not a historical proof |
| 1H Sweep + iFVG + 1M BOS | Original DoctorTrades rules | Existing baseline; independent paper account | Pattern definitions require continued audit against live charts |
| NQ Opening Range Breakout | [giovannibrusco/nq-intraday-breakout](https://github.com/giovannibrusco/nq-intraday-breakout), MIT | Independently implemented as a 90-minute cash ORB | The repository uses a 100-point stop that cannot fit this platform's $500 NQ risk cap; this build uses a clearly labeled volatility-scaled variant |
| EMA 20/60 Momentum | [QuantConnect LEAN FuturesMomentumAlgorithm](https://github.com/QuantConnect/Lean/blob/master/Algorithm.CSharp/FuturesMomentumAlgorithm.cs), Apache-2.0 | Independently implemented on completed NQ 15-minute bars | The reference is an example, not an NQ profitability claim; this adaptation needs its own evidence |
| Volume POC Reversion | [s4g4cr/nq-quant-research](https://github.com/s4g4cr/nq-quant-research), no detected license | Concept independently implemented; no source code copied | One-minute OHLCV cannot reproduce a true tick-level volume profile, so this is explicitly a bar-volume POC proxy |

## Screened but not installed

| Repository | Decision | Reason |
| --- | --- | --- |
| [dws-data/nas-orb-backtester](https://github.com/dws-data/nas-orb-backtester) | Research reference only | Useful NQ ORB/retrace claims, but no license was detected; do not copy code |
| [cayao2012/ICT-bot](https://github.com/cayao2012/ICT-bot) | Not installed | Reported test covers only 41 trading days and no license was detected; overfitting and reuse risk are too high |
| [Lumiwealth/lumibot](https://github.com/Lumiwealth/lumibot) | Framework reference | A trading framework is not evidence that a strategy works; adding it would duplicate the current engine |
| [SolomonBell/strategy-foundry](https://github.com/SolomonBell/strategy-foundry) | Rejected as evidence | Its published metrics are described as simulated/synthetic and do not establish out-of-sample performance |

## Evidence gates

A bot remains in `Warming up` or `Collecting evidence` until its own forward paper journal supports evaluation. `Paper candidate` requires all of these:

- at least 50 closed paper trades
- at least 20 distinct trading days
- profit factor of at least 1.20
- positive expectancy per trade
- positive average R
- maximum test drawdown no greater than $1,500

Passing these gates does not authorize real-money execution. It only means the strategy has earned deeper review, longer walk-forward testing, parameter perturbation, and an independent data-quality audit.

## Research integrity rules

- Never merge journals between bots.
- Never delete losing trades from an evaluation window.
- Never tune a strategy on the same window used to score it.
- Record the exact fill convention, costs, session timezone, continuous-contract mapping, and same-candle stop/target rule.
- Treat missing licenses as “read concepts only”; do not copy source code.
- Keep Telegram limited to actual paper fills and closes.
- Do not connect a broker or enable real orders through this research network.
