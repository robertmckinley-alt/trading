import AppHeader from '../../components/app-header';
import FocusPaperBoard from '../../components/focus-paper-board';
import { getStrategySnapshots } from '../../lib/live-status.cjs';
import { buildFocusPaperView } from '../../lib/focus-paper-view.cjs';
import policy from '../../config/focus-paper-v2.json';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata = {
  title: '$1,000-risk paper trial · DoctorTrades',
  description: 'Five separate paper accounts with up to $1,000 planned risk per trade, new realized P&L, and an isolated VWAP confirmation comparison.'
};

export default async function ProfitFocusPage() {
  let snapshot;
  try {
    snapshot = await getStrategySnapshots();
  } catch {
    snapshot = { ok: false, source: 'unavailable', strategies: [] };
  }
  const report = buildFocusPaperView(snapshot, policy);
  const limits = Object.fromEntries(['riskPerTradeUsd', 'dailyLossLimitUsd', 'portfolioOpenRiskUsd', 'familyOpenRiskUsd', 'startingBalanceUsd'].map(key => [key, policy[key]]));
  return (
    <main className="page-shell command-page" id="main-content">
      <AppHeader section="Profit Focus · separate $1,000-risk paper trial" />
      <FocusPaperBoard initialReport={report} accountDefinitions={policy.parents} policyLimits={limits} />
    </main>
  );
}
