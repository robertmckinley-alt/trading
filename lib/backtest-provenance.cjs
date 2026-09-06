const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { groupTradingDays } = require('./backtest-engine.cjs');

function backtestProvenance(candles, window) {
  const code = createHash('sha256');
  for (const name of ['backtest-engine.cjs', 'backtest-service.cjs', 'backtest-provenance.cjs', 'trader-core.cjs', 'live-trader.cjs', 'strategy-registry.cjs', 'orb-learning.cjs', 'historical-data.cjs']) {
    code.update(name).update(fs.readFileSync(path.join(__dirname, name)));
  }
  const data = createHash('sha256');
  for (const candle of candles) data.update(JSON.stringify(candle)).update('\n');
  const sessions = groupTradingDays(candles).filter(([, records]) => records.some((record) => record.minute >= 570 && record.minute < 960));
  const tradingDates = sessions.map(([date]) => date);
  const issues = [];
  for (const [date, records] of sessions) {
    const minutes = new Set(records.filter((record) => record.minute >= 570 && record.minute < 960).map((record) => record.minute));
    if (minutes.size !== 390) issues.push(`${date}: ${minutes.size}/390 cash-session minutes; shortened session or missing data needs calendar review.`);
  }
  const known = new Set(tradingDates);
  // Without an exchange calendar, do not silently treat an absent weekday as a holiday.
  for (let time = Date.parse(window.start.slice(0, 10)); time < Date.parse(window.end.slice(0, 10)); time += 86400000) {
    const day = new Date(time);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6 && !known.has(day.toISOString().slice(0, 10))) {
      issues.push(`${day.toISOString().slice(0, 10)}: no cash session; exchange closure or missing data needs calendar review.`);
    }
  }
  return { executionVersion: 'orb-execution-v2', codeHash: code.digest('hex'), dataFingerprint: data.digest('hex'),
    tradingDates, coverage: { complete: issues.length === 0 && sessions.length > 0, issues,
      scope: '390-minute observed cash sessions; holidays and shortened sessions require calendar review.' } };
}

module.exports = { backtestProvenance };
