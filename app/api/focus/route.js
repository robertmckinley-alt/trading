import { NextResponse } from 'next/server';
import { getStrategySnapshots } from '../../../lib/live-status.cjs';
import { buildFocusReport } from '../../../lib/profit-focus.cjs';
import manifest from '../../../config/profit-focus-v1.json';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const snapshot = await getStrategySnapshots();
  const report = buildFocusReport(snapshot, manifest);
  return NextResponse.json(report, {
    status: report.dataStatus.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' }
  });
}
