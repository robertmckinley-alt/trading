import AppHeader from '../../../components/app-header';
import ProfitFocusBoard from '../../../components/profit-focus-board';
import { getStrategySnapshots } from '../../../lib/live-status.cjs';
import { buildFocusReport } from '../../../lib/profit-focus.cjs';
import manifest from '../../../config/profit-focus-v1.json';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata = {
  title: 'Frozen v1 baseline · DoctorTrades',
  description: 'Original Profit Focus selection and frozen prospective validation, preserved separately from the $1,000-risk paper accounts.'
};

export default async function ProfitFocusBaselinePage() {
  let snapshot;
  try {
    snapshot = await getStrategySnapshots();
  } catch {
    snapshot = { ok: false, source: 'unavailable', strategies: [] };
  }
  const report = buildFocusReport(snapshot, manifest);
  return (
    <main className="page-shell command-page" id="main-content">
      <AppHeader section="Profit Focus · frozen v1 baseline" />
      <p style={{ margin: '22px 0 0', fontSize: 13 }}>Original v1 selection and trial. <Link href="/focus">Open the separate $1,000-risk paper trial →</Link></p>
      <ProfitFocusBoard initialReport={report} />
    </main>
  );
}
