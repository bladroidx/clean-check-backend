import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckReport } from '@imei-check/contract';
import { toSignal } from '../src/routes/check-shared.js';
import { SENTINEL } from './helpers.js';
import { BLOCKED, FakeProvider, idempotencyKey, makePaidApp, type PaidHarness } from './paid-helpers.js';

/**
 * Found by the local stack's first real run: over a REAL socket, every deep check came back
 * `unavailable(provider_timeout)` -- "Not attempted: the deep-check time budget was spent" -- in
 * 0 s, and not one order was ever placed.
 *
 * `toSignal` read `request.raw.destroyed === true` as "the client hung up". But Node marks an
 * IncomingMessage destroyed as soon as its body has been consumed, and Fastify consumes the body
 * before the handler runs, so every POST aborted its own budget on arrival. `inject()` never
 * showed it: its request object is not auto-destroyed. Hence this test goes over a real port.
 */

let harness: PaidHarness | undefined;

afterEach(async () => {
  await harness?.app.close();
  harness = undefined;
});

describe('the deep-check budget over a real HTTP connection', () => {
  it('a POST with a body still reaches the supplier', async () => {
    const provider = new FakeProvider('fake', BLOCKED);
    harness = await makePaidApp({ providers: [provider], deepWaitMs: 2_000 });
    await harness.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = harness.app.server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/v1/deep_checks`, {
      method: 'POST',
      headers: { ...harness.auth(), 'idempotency-key': idempotencyKey(), 'content-type': 'application/json' },
      body: JSON.stringify({ imei: SENTINEL }),
    });
    expect(res.status).toBe(200);
    const report = (await res.json()) as CheckReport;

    expect(provider.executed).toHaveLength(1);
    expect(report.sections['blacklist.gsma']).toMatchObject({ outcome: 'fail' });
    expect(report.summary.verdict).toBe('red');
  });
});

describe('toSignal', () => {
  /** A stand-in for the ServerResponse: `close` fires on completion AND on a dropped connection. */
  const response = (state: { writableFinished?: boolean; destroyed?: boolean } = {}) =>
    Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false, ...state });

  it('aborts when the connection closes before the response is sent', () => {
    const res = response();
    const signal = toSignal(res);
    expect(signal.aborted).toBe(false);
    res.emit('close');
    expect(signal.aborted).toBe(true);
  });

  it('does not abort when close is just the response finishing', () => {
    const res = response();
    const signal = toSignal(res);
    res.writableFinished = true;
    res.emit('close');
    expect(signal.aborted).toBe(false);
  });

  it('is aborted from the start when the response is already destroyed', () => {
    expect(toSignal(response({ destroyed: true })).aborted).toBe(true);
  });
});
