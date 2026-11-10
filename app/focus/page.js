import AppHeader from '../../components/app-header';
import ProfitFocusBoard from '../../components/profit-focus-board';
import { getStrategySnapshots } from '../../lib/live-status.cjs';
import { buildFocusReport } from '../../lib/profit-focus.cjs';
import manifest from '../../config/profit-focus-v1.json';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata = {
  title: 'Profit Focus · DoctorTrades',
  description: 'Five selected paper strategies, their historical profit drivers, and a separate frozen forward validation trial.'
};

export default async function ProfitFocusPage() {
  let snapshot;
  try {
    snapshot = await getStrategySnapshots();
  } catch {
    snapshot = { ok: false, source: 'unavailable', strategies: [] };
  }
  const report = buildFocusReport(snapshot, manifest);
  return (
    <main className="page-shell command-page" id="main-content">
      <AppHeader section="Profit Focus · paper validation" />
      <ProfitFocusBoard initialReport={report} />
    </main>
  );
}
