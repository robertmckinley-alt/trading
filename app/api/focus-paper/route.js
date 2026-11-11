import { NextResponse } from 'next/server';
import { getStrategySnapshots } from '../../../lib/live-status.cjs';
import { buildFocusPaperView } from '../../../lib/focus-paper-view.cjs';
import policy from '../../../config/focus-paper-v2.json';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const report = buildFocusPaperView(await getStrategySnapshots(), policy);
  return NextResponse.json(report, { status: report.dataStatus.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
