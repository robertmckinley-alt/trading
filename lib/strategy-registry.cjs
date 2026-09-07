const path = require('path');

const STRATEGIES = Object.freeze([
  {
    slug: 'live-9am-sweep',
    name: '9AM Asia/London Sweep',
    shortName: '9AM sweep',
    paperAccountLabel: 'Paper Account A',
    strategyFamily: 'liquidity-reversal',
    strategyFamilyName: 'Liquidity reversal',
    activationTime: '09:00 America/New_York',
    researchStage: 'Forward paper test',
    evidenceLabel: 'Original platform strategy',
    description: 'Sweeps an overnight Asia or London extreme, then requires a one-minute fair-value-gap reversal.',
    source: {
      label: 'DoctorTrades rule set',
      url: null,
      license: 'User-supplied rules',
      status: 'Internal baseline'
    }
  },
  {
    slug: 'hourly-sweep-ifvg-bos',
    name: '1H Sweep + iFVG + 1M BOS',
    shortName: 'Hourly iFVG',
    paperAccountLabel: 'Paper Account B',
    strategyFamily: 'liquidity-reversal',
    strategyFamilyName: 'Liquidity reversal',
    activationTime: 'Rolling 1H liquidity',
    researchStage: 'Forward paper test',
    evidenceLabel: 'Original platform strategy',
    description: 'Looks for a rolling hourly liquidity sweep with imbalance and one-minute structure confirmation.',
    source: {
      label: 'DoctorTrades rule set',
      url: null,
      license: 'User-supplied rules',
      status: 'Internal baseline'
    }
  },
  {
    slug: 'nq-opening-range-breakout',
    name: 'NQ Opening Range Breakout',
    shortName: 'NQ ORB',
    paperAccountLabel: 'Paper Account C',
    strategyFamily: 'cash-breakout',
    strategyFamilyName: 'Cash-session breakout',
    activationTime: '11:00–15:30 America/New_York',
    researchStage: 'Reproduction pending',
    evidenceLabel: 'External backtest claim; not independently verified',
    description: 'Trades a break of the first 90 minutes of the cash session with a risk-normalized stop for the $500 paper cap.',
    source: {
      label: 'nq-intraday-breakout',
      url: 'https://github.com/giovannibrusco/nq-intraday-breakout',
      license: 'MIT',
      status: 'Rules adapted; no source code copied'
    }
  },
  {
    slug: 'ema-20-60-momentum',
    name: 'EMA 20/60 Momentum',
    shortName: 'EMA momentum',
    paperAccountLabel: 'Paper Account D',
    strategyFamily: 'trend-momentum',
    strategyFamilyName: 'Trend momentum',
    activationTime: '09:30–15:45 America/New_York',
    researchStage: 'Forward paper test',
    evidenceLabel: 'Reference implementation; NQ adaptation unverified',
    description: 'Uses a 20/60 EMA crossover on completed 15-minute bars with volatility-scaled paper exits.',
    source: {
      label: 'QuantConnect LEAN FuturesMomentumAlgorithm',
      url: 'https://github.com/QuantConnect/Lean/blob/master/Algorithm.CSharp/FuturesMomentumAlgorithm.cs',
      license: 'Apache-2.0',
      status: 'Independently implemented for this engine'
    }
  },
  {
    slug: 'volume-poc-reversion',
    name: 'Volume POC Reversion',
    shortName: 'POC reversion',
    paperAccountLabel: 'Paper Account E',
    strategyFamily: 'value-reversion',
    strategyFamilyName: 'Value reversion',
    activationTime: '10:30–15:45 America/New_York',
    researchStage: 'Research proxy',
    evidenceLabel: 'External research claim; bar-volume proxy only',
    description: 'Fades an exhausted move at least one ATR from a one-minute volume-profile point of control.',
    source: {
      label: 'nq-quant-research',
      url: 'https://github.com/s4g4cr/nq-quant-research',
      license: 'No license detected',
      status: 'Concept referenced; no source code copied'
    }
  },
  {
    slug: 'nq-15m-opening-range-retest',
    name: 'NQ 15M Opening Range Retest',
    shortName: '15M OR retest',
    paperAccountLabel: 'Paper Account F',
    strategyFamily: 'cash-breakout',
    strategyFamilyName: 'Cash-session breakout',
    activationTime: '09:45–11:30 America/New_York',
    researchStage: 'Forward paper test',
    evidenceLabel: 'Video-sourced rules; independently specified for paper testing',
    description: 'Marks the 09:30–09:45 Nasdaq range, then requires a directional break, a level-holding retest, and aligned five-minute order flow.',
    source: {
      label: 'User-supplied strategy video',
      url: null,
      license: 'Rules independently implemented',
      status: 'Paper-only hypothesis'
    }
  },
  {
    slug: 'nq-15m-orb-close-confirmation',
    name: 'NQ 15M ORB Close Confirmation',
    shortName: '15M ORB close',
    paperAccountLabel: 'Paper Account G',
    strategyFamily: 'cash-breakout',
    strategyFamilyName: 'Cash-session breakout',
    activationTime: '09:45–11:30 America/New_York',
    researchStage: 'Reproduction pending',
    evidenceLabel: 'Video-inspired rules; proprietary V1–V4 logic not disclosed',
    description: 'Trades a completed 15-minute close outside the 09:30–09:45 range, with a body-quality filter that rejects wick-heavy false breaks.',
    source: {
      label: 'User-supplied Tradex ORB Sniper v3.6 video',
      url: null,
      license: 'Independent, disclosed-rule implementation',
      status: 'Paper-only hypothesis; not a clone of the proprietary indicator'
    }
  },
  {
    slug: 'nq-dmc-market-open',
    name: 'NQ DMC Market Open',
    shortName: 'DMC market open',
    paperAccountLabel: 'Paper Account H',
    strategyFamily: 'cash-breakout',
    strategyFamilyName: 'Cash-session breakout',
    activationTime: '09:30–10:30 America/New_York',
    researchStage: 'Forward paper test',
    evidenceLabel: 'Video-sourced method; deterministic translation unvalidated',
    description: 'Uses the final completed pre-open hour, fresh hourly candle-body pivots, and a completed five-minute hold before placing an exact-level limit order.',
    source: {
      label: 'Hunter DMC educational method',
      url: 'https://www.youtube.com/playlist?list=PLtfjD7dzYgl2pxX01F_wKsw-t_VJVo05m',
      license: 'Rules independently translated; no source code copied',
      status: 'Paper-only hypothesis'
    }
  },
  {
    slug: 'nq-htf-session-sweep',
    name: 'NQ HTF Session Sweep',
    shortName: 'HTF session sweep',
    paperAccountLabel: 'Paper Account I',
    strategyFamily: 'liquidity-reversal',
    strategyFamilyName: 'Liquidity reversal',
    activationTime: '08:00–11:30 America/New_York',
    researchStage: 'Forward paper test',
    evidenceLabel: 'Video-inspired rules; deterministic translation unvalidated',
    description: 'Requires a one-sided London sweep of the Asia range, aligned completed hourly direction, a five-minute close back inside the range, and a one-minute structure break.',
    source: {
      label: 'User-supplied strategy videos',
      url: null,
      license: 'Rules independently specified; no source code copied',
      status: 'Paper-only hypothesis'
    }
  }
]);

const ORB_RESEARCH_VARIANTS = Object.freeze([
  {
    slug: 'nq-15m-orb-delayed-confirmation',
    name: 'ORB Test: Delayed Confirmation',
    shortName: 'ORB delayed',
    strategyFamily: 'cash-breakout',
    strategyFamilyName: 'Cash-session breakout',
    activationTime: '10:14–11:29 America/New_York',
    researchStage: 'Historical candidate',
    evidenceLabel: 'Single-variable ORB timing test',
    description: 'Keeps the baseline ORB rules but ignores the first 09:59 confirmation candle.',
    source: { label: '2026 weakness audit', url: null, license: 'Internal research rule', status: 'Backtest-only candidate' }
  },
  {
    slug: 'nq-15m-orb-no-monday',
    name: 'ORB Test: No Monday Trades',
    shortName: 'ORB no Monday',
    strategyFamily: 'cash-breakout',
    strategyFamilyName: 'Cash-session breakout',
    activationTime: 'Tuesday–Friday, 09:59–11:29 America/New_York',
    researchStage: 'Historical candidate',
    evidenceLabel: 'Single-variable ORB weekday test',
    description: 'Keeps the baseline ORB rules but does not accept Monday signals.',
    source: { label: '2026 weakness audit', url: null, license: 'Internal research rule', status: 'Backtest-only candidate' }
  },
  {
    slug: 'nq-15m-orb-body-window',
    name: 'ORB Test: 50–80% Body',
    shortName: 'ORB body window',
    strategyFamily: 'cash-breakout',
    strategyFamilyName: 'Cash-session breakout',
    activationTime: '09:59–11:29 America/New_York',
    researchStage: 'Historical candidate',
    evidenceLabel: 'Single-variable ORB candle-body test',
    description: 'Keeps the baseline ORB rules while rejecting confirmation candles whose bodies exceed 80% of their range.',
    source: { label: '2026 weakness audit', url: null, license: 'Internal research rule', status: 'Backtest-only candidate' }
  },
  {
    slug: 'nq-15m-orb-focused-time',
    name: 'ORB Test: 10:14–10:59 Only',
    shortName: 'ORB focused time',
    strategyFamily: 'cash-breakout',
    strategyFamilyName: 'Cash-session breakout',
    activationTime: '10:14–10:59 America/New_York',
    researchStage: 'Historical candidate',
    evidenceLabel: 'Single-variable ORB confirmation-window test',
    description: 'Keeps the baseline ORB rules but only accepts completed confirmation bars ending from 10:14 through 10:59.',
    source: { label: '2026 weakness audit', url: null, license: 'Internal research rule', status: 'Backtest-only candidate' }
  }
]);

// Frozen, preregistered hypotheses. These thresholds have not been validated.
const ORB_FILTER_RULES = Object.freeze({
  'nq-15m-orb-atr': Object.freeze({ useAtr: true, minimumOpeningAtrRatio: 0.05, maximumOpeningAtrRatio: 0.30 }),
  'nq-15m-orb-rvol': Object.freeze({ useRelativeVolume: true, minimumRelativeVolume: 1.2 }),
  'nq-15m-orb-atr-rvol': Object.freeze({ useAtr: true, minimumOpeningAtrRatio: 0.05, maximumOpeningAtrRatio: 0.30, useRelativeVolume: true, minimumRelativeVolume: 1.2 }),
  'nq-15m-orb-wick-test': Object.freeze({ maximumBreakoutWickFraction: 0.15 })
});
const ORB_FILTER_VARIANTS = Object.freeze([
  ['nq-15m-orb-atr', 'ORB Test: Prior-session ATR', 'Opening-range width must be 5–30% of the mean true range of the prior 14 complete cash sessions.'],
  ['nq-15m-orb-rvol', 'ORB Test: Relative Volume', 'Confirmation volume must be at least 1.2 times the same 15-minute slot across the prior 20 complete cash sessions, with at least 10 samples.'],
  ['nq-15m-orb-atr-rvol', 'ORB Test: ATR + Relative Volume', 'Combines the same preregistered ATR and relative-volume filters without changing their thresholds.'],
  ['nq-15m-orb-wick-test', 'ORB Test: 15% Breakout Wick', 'Limits the breakout-side confirmation wick to 15% of its range, keeping other baseline rules.']
].map(([slug, name, description]) => Object.freeze({
  slug, name, shortName: name.replace('ORB Test: ', 'ORB '),
  strategyFamily: 'cash-breakout', strategyFamilyName: 'Cash-session breakout',
  activationTime: '09:59–11:29 America/New_York', researchStage: 'Unvalidated historical candidate',
  evidenceLabel: 'Frozen filter hypothesis; requires forward paper validation', description,
  researchRules: ORB_FILTER_RULES[slug],
  source: { label: 'ORB research design', url: null, license: 'Independent implementation', status: 'Backtest-only candidate' }
})));

const STRATEGY_RESEARCH_VARIANTS = Object.freeze([
  {
    slug: 'live-9am-sweep-min-stop', name: '9AM Test: Minimum 10-Point Stop', shortName: '9AM min stop',
    strategyFamily: 'liquidity-reversal', strategyFamilyName: 'Liquidity reversal', activationTime: '09:00 America/New_York',
    researchStage: 'Historical candidate', evidenceLabel: 'Single-variable stop-width test',
    description: 'Keeps the 9AM sweep rules but rejects setups with less than 10 NQ points of structural risk.',
    source: { label: '2026 weakness audit', url: null, license: 'Internal research rule', status: 'Backtest-only candidate' }
  },
  {
    slug: 'hourly-sweep-stop-band', name: 'Hourly Test: 8.25–16 Point Stop', shortName: 'Hourly stop band',
    strategyFamily: 'liquidity-reversal', strategyFamilyName: 'Liquidity reversal', activationTime: 'Rolling 1H liquidity',
    researchStage: 'Historical candidate', evidenceLabel: 'Single-variable stop-width test',
    description: 'Uses corrected nearest-first targets and accepts only hourly setups with 8.25–16 NQ points of risk.',
    source: { label: '2026 weakness audit', url: null, license: 'Internal research rule', status: 'Backtest-only candidate' }
  },
  {
    slug: 'nq-opening-range-true-breakout', name: '90M ORB Test: True Breakout', shortName: '90M true breakout',
    strategyFamily: 'cash-breakout', strategyFamilyName: 'Cash-session breakout', activationTime: '11:00–15:30 America/New_York',
    researchStage: 'Historical candidate', evidenceLabel: 'Independent execution-model test',
    description: 'Enters from the confirmed breakout close instead of waiting for an implicit retest of the range boundary.',
    source: { label: '2026 weakness audit', url: null, license: 'Internal research rule', status: 'Backtest-only candidate' }
  },
  {
    slug: 'ema-20-60-cash-window', name: 'EMA Test: 10:15–11:15 Window', shortName: 'EMA cash window',
    strategyFamily: 'trend-momentum', strategyFamilyName: 'Trend momentum', activationTime: '10:15–11:15 America/New_York',
    researchStage: 'Historical candidate', evidenceLabel: 'Single-variable time-window test',
    description: 'Keeps the EMA 20/60 crossover rules but limits completed signals to the strongest audited cash-session window.',
    source: { label: '2026 weakness audit', url: null, license: 'Internal research rule', status: 'Backtest-only candidate' }
  },
  {
    slug: 'volume-poc-max-3atr', name: 'POC Test: Maximum 3 ATR', shortName: 'POC 3 ATR cap',
    strategyFamily: 'value-reversion', strategyFamilyName: 'Value reversion', activationTime: '10:30–15:45 America/New_York',
    researchStage: 'Historical candidate', evidenceLabel: 'Single-variable distance test',
    description: 'Keeps the POC reversion rules but rejects entries farther than three ATR from the POC proxy.',
    source: { label: '2026 weakness audit', url: null, license: 'Internal research rule', status: 'Backtest-only candidate' }
  },
  {
    slug: 'nq-15m-retest-continuation', name: '15M Retest Test: Continuation Entry', shortName: 'Retest continuation',
    strategyFamily: 'cash-breakout', strategyFamilyName: 'Cash-session breakout', activationTime: '09:45–11:30 America/New_York',
    researchStage: 'Historical candidate', evidenceLabel: 'Independent execution-model test',
    description: 'Enters one tick beyond the confirming retest candle and places the stop beyond its opposite extreme.',
    source: { label: '2026 weakness audit', url: null, license: 'Internal research rule', status: 'Backtest-only candidate' }
  }
]);

const BACKTEST_STRATEGIES = Object.freeze([...STRATEGIES, ...ORB_RESEARCH_VARIANTS, ...ORB_FILTER_VARIANTS, ...STRATEGY_RESEARCH_VARIANTS]);

function getStrategyDefinition(slug) {
  return STRATEGIES.find((strategy) => strategy.slug === slug) || null;
}

function requireStrategyDefinition(slug) {
  const strategy = getStrategyDefinition(slug);
  if (!strategy) {
    throw new Error(`Unknown strategy: ${slug}. Choose one of: ${STRATEGIES.map((item) => item.slug).join(', ')}`);
  }
  return strategy;
}

function runtimeFilesForStrategy(rootDir, slug) {
  requireStrategyDefinition(slug);
  const isLegacyNineAm = slug === 'live-9am-sweep';
  return {
    statePath: path.join(rootDir, isLegacyNineAm ? 'state.json' : `state-${slug}.json`),
    pidPath: path.join(rootDir, 'runtime', isLegacyNineAm ? 'lucid-nq-paper-trader-watch.pid' : `${slug}-watch.pid`),
    logPath: path.join(rootDir, 'runtime', isLegacyNineAm ? 'lucid-nq-paper-trader-watch.log' : `${slug}-watch.log`)
  };
}

module.exports = {
  BACKTEST_STRATEGIES,
  ORB_RESEARCH_VARIANTS,
  ORB_FILTER_VARIANTS,
  ORB_FILTER_RULES,
  STRATEGY_RESEARCH_VARIANTS,
  STRATEGIES,
  getStrategyDefinition,
  requireStrategyDefinition,
  runtimeFilesForStrategy
};
