import { NextResponse } from 'next/server';
import { getStrategySnapshots } from '../../../lib/live-status.cjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const payload = await getStrategySnapshots();
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message
      },
      { status: 500 }
    );
  }
}
