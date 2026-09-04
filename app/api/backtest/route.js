import { NextResponse } from 'next/server';
import { backtestConfigured, executeBacktest, getCachedBacktest } from '../../../lib/backtest-service.cjs';
import { isOperatorAuthConfigured, isOperatorRequest, isTrustedMutationOrigin } from '../../../lib/operator-auth.mjs';
import { createRequestLog } from '../../../lib/request-log.mjs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request) {
  const result = await getCachedBacktest();
  return NextResponse.json({
    ok: true,
    configured: backtestConfigured(),
    operatorConfigured: isOperatorAuthConfigured(),
    authenticated: isOperatorRequest(request),
    defaultDays: 60,
    result
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  const log = createRequestLog(request, '/api/backtest');
  if (!isTrustedMutationOrigin(request)) {
    log.done(403, { errorType: 'origin' });
    return NextResponse.json({ ok: false, error: 'Untrusted request origin.' }, { status: 403 });
  }
  if (!isOperatorRequest(request)) {
    log.done(401, { errorType: 'authentication' });
    return NextResponse.json({ ok: false, error: 'Unlock operator access before running a paid historical backtest.' }, { status: 401 });
  }
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 4096) throw new Error('Backtest request is too large.');
    const body = await request.json();
    const days = Math.max(10, Math.min(90, Math.round(Number(body.days) || 60)));
    const result = await executeBacktest({ days });
    log.done(200, { days, candles: result.candles, strategies: result.strategies?.length || 0 });
    return NextResponse.json({ ok: true, result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    log.done(503, { errorType: error.name });
    return NextResponse.json({ ok: false, error: error.message }, { status: 503 });
  }
}
