// User-approved forward PAPER collection profile. Never a frequency guarantee.
const VERSION = 'paper-collection-v2-2026-10-02';
const SLUGS = ['nq-dmc-market-open', 'nq-dmc-failed-level-reversal', 'nq-dmc-gain-retest', 'nq-htf-session-sweep', 'nq-vwap-stretch-reversion'];
function active(config) {
  return config.live?.paperCollection?.enabled === true && SLUGS.includes(config.detectorStrategySlug || config.strategySlug);
}
function version(config) { return active(config) ? VERSION : 'baseline'; }
module.exports = { VERSION, SLUGS, active, version };
