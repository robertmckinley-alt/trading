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
  }
]);

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
  STRATEGIES,
  getStrategyDefinition,
  requireStrategyDefinition,
  runtimeFilesForStrategy
};
