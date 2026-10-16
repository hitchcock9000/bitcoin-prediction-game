#!/usr/bin/env node
/**
 * End-to-end smoke test against a running server.
 *
 * This drives the *complete* user journey over real HTTP and checks the
 * business rules that matter, including the one thing no unit test can prove:
 * that a prediction created now is settled by the server roughly a minute
 * later, with the score moved exactly once.
 *
 * It is deliberately a separate script rather than part of the Vitest suite:
 * it takes ~70 seconds because the 60-second rule is real, and it is meant to
 * be run by hand after a deployment to answer "does this URL actually work?".
 *
 * Usage:
 *   node scripts/smoke.mjs                                  # http://localhost:3000
 *   node scripts/smoke.mjs --base-url https://example.com
 *   node scripts/smoke.mjs --expect-simulated               # sandbox/demo deploy
 */
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const baseUrl = (argValue('--base-url', process.env.SMOKE_BASE_URL ?? 'http://localhost:3000')).replace(/\/$/, '');
const expectSimulated = args.includes('--expect-simulated');
const maxWaitSeconds = Number(argValue('--max-wait-seconds', '150'));

let cookie = null;
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (init.body) headers.set('content-type', 'application/json');

  const response = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: 'manual' });

  const setCookie = response.headers.getSetCookie?.()[0];
  if (setCookie) cookie = setCookie.split(';')[0];

  let body = null;
  try {
    body = await response.json();
  } catch {
    /* some responses have no body */
  }
  return { status: response.status, body, headers: response.headers };
}

async function main() {
  console.log(`Smoke test against ${baseUrl}\n`);

  // 1. Health
  const health = await api('/api/health');
  record(
    'GET /api/health returns ok',
    health.status === 200 && health.body?.ok === true,
    `status=${health.status} database=${health.body?.database} scheduler=${health.body?.settlement?.schedulerRunning}`,
  );
  record(
    'settlement scheduler is running in this process',
    health.body?.settlement?.schedulerRunning === true,
    `enabled=${health.body?.settlement?.schedulerEnabled}`,
  );
  if (expectSimulated) {
    record(
      'deployment is labelled as simulated',
      health.body?.priceProvider?.simulated === true,
      `provider=${health.body?.priceProvider?.name}`,
    );
  }

  // 2. New player
  const first = await api('/api/state');
  record('GET /api/state issues a player cookie', Boolean(cookie), cookie ? 'cookie set' : 'no cookie');
  record(
    'new player starts at zero',
    first.body?.player?.score === 0,
    `score=${first.body?.player?.score}`,
  );
  const price = first.body?.market?.price ?? null;
  record('a BTC/USD price is available', typeof price === 'string' && price.length > 0, `price=${price}`);
  if (!price) {
    finish();
    return;
  }

  // 3. Create a prediction
  const created = await api('/api/predictions', { method: 'POST', body: JSON.stringify({ direction: 'up' }) });
  record(
    'POST /api/predictions creates a prediction',
    created.status === 201 && Boolean(created.body?.activePrediction),
    `status=${created.status} entry=${created.body?.activePrediction?.entryPrice}`,
  );
  if (!created.body?.activePrediction) {
    finish();
    return;
  }
  const entryPrice = created.body.activePrediction.entryPrice;
  const predictionId = created.body.activePrediction.id;
  const secondsRemaining = created.body.activePrediction.secondsRemaining;
  record(
    'the minimum wait is enforced (60s)',
    secondsRemaining > 0 && secondsRemaining <= 60,
    `secondsRemaining=${secondsRemaining}`,
  );

  // 4. A second prediction is refused
  const duplicate = await api('/api/predictions', { method: 'POST', body: JSON.stringify({ direction: 'down' }) });
  record(
    'a second open prediction is refused',
    duplicate.status === 409,
    `status=${duplicate.status} code=${duplicate.body?.error?.code}`,
  );

  // 5. The prediction is still pending immediately afterwards
  const immediate = await api('/api/state');
  record(
    'the prediction is still pending after a refresh',
    immediate.body?.activePrediction?.id === predictionId,
    `explanation="${immediate.body?.activePrediction?.explanation}"`,
  );

  // 6. Poll state until the server reports the prediction as settled. On a
  // serverless deployment, these state requests may themselves trigger the
  // bounded settlement sweep.
  console.log(`\nPolling for up to ${maxWaitSeconds}s until the server reports settlement...`);
  const startedAt = Date.now();
  let settled = null;
  while ((Date.now() - startedAt) / 1000 < maxWaitSeconds) {
    await sleep(5_000);
    const state = await api('/api/state');
    if (state.body?.activePrediction === null) {
      settled = state.body;
      break;
    }
    const left = state.body?.activePrediction?.secondsRemaining;
    process.stdout.write(`  … still open (${left}s left)\n`);
  }

  if (!settled) {
    record('the prediction settles while state is polled', false, `still pending after ${maxWaitSeconds}s`);
    finish();
    return;
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const result = settled.latestPrediction;
  record('the prediction resolves', Boolean(result && result.status === 'resolved'), `outcome=${result?.outcome}`);

  const entryNumber = Number(entryPrice);
  const settlementNumber = result?.settlementPrice ? Number(result.settlementPrice) : null;
  const expectedOutcome =
    settlementNumber === null || settlementNumber === entryNumber
      ? null
      : settlementNumber > entryNumber
        ? 'win'
        : 'loss';

  record(
    'the outcome matches the price movement',
    expectedOutcome !== null && result?.outcome === expectedOutcome,
    `entry=${entryPrice} settlement=${result?.settlementPrice} outcome=${result?.outcome}`,
  );
  const expectedDelta = expectedOutcome === 'win' ? 1 : expectedOutcome === 'loss' ? -1 : null;
  record(
    'the score moved by exactly one point',
    expectedOutcome !== null &&
      settled.player?.score === expectedDelta &&
      result?.scoreDelta === expectedDelta,
    `score=${settled.player?.score} delta=${result?.scoreDelta}`,
  );
  console.log(`\nSettled ${elapsed}s after the sweep started (the wait itself is server-side).`);

  // 7. The score survives a new "session" (same cookie, fresh requests).
  const afterRefresh = await api('/api/state');
  record(
    'score and result persist across refreshes',
    afterRefresh.body?.player?.score === 1 && afterRefresh.body?.latestPrediction?.id === result?.id,
    `score=${afterRefresh.body?.player?.score}`,
  );

  finish();
}

function finish() {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('Failures:');
    for (const failure of failed) console.log(`  - ${failure.name} (${failure.detail})`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Smoke test errored:', error);
  process.exit(1);
});
