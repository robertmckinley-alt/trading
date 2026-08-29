import path from 'path';
import { NextResponse } from 'next/server';
import {
  buildTradePlan,
  createEmptyState,
  hydrateState,
  loadJson,
  normalizeConfig,
  normalizeSetup,
  validateSetup
} from '../../../lib/trader-core.cjs';

function loadConfig() {
  return normalizeConfig(loadJson(path.join(process.cwd(), 'config.json')));
}

export async function POST(request) {
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 250_000) {
      return NextResponse.json({ ok: false, error: 'Plan request is too large.' }, { status: 413 });
    }
    const { setup, journalState } = await request.json();
    const config = loadConfig();
    const normalizedSetup = normalizeSetup(setup, config);
    const validation = validateSetup(normalizedSetup, config);

    if (!validation.valid) {
      return NextResponse.json({ ok: false, errors: validation.errors }, { status: 400 });
    }

    const state = journalState ? hydrateState(journalState, config) : createEmptyState(config);
    const plan = buildTradePlan(normalizedSetup, config, state);
    return NextResponse.json({ ok: true, config, plan });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
}
