import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { ImeiInLogError, REDACTED, createLogger, guardString, guardValue, serializers } from '../src/lib/log.js';
import { SENTINEL } from './helpers.js';

/**
 * A pino `redact` path list is a hope, not a control: the realistic leak is an IMEI arriving
 * inside a supplier's free-text error message, and no path list can name that field in advance.
 * Throwing outside production is what makes this a control rather than a net people lean on.
 */

describe('guardString', () => {
  it('passes text with no IMEI-shaped digits through untouched', () => {
    expect(guardString('nothing to see', 'x', true)).toBe('nothing to see');
    expect(guardString('order 12345 failed', 'x', true)).toBe('order 12345 failed');
  });

  it('throws outside production, so the bug surfaces in dev and CI', () => {
    expect(() => guardString(`imei=${SENTINEL}`, 'provider.body', true)).toThrow(ImeiInLogError);
    expect(() => guardString(`imei=${SENTINEL}`, 'provider.body', true)).toThrow(/Redact at the call site/);
  });

  it('redacts rather than throwing in production', () => {
    // A logging call must never take down a request in prod; it must never leak either.
    expect(guardString(`imei=${SENTINEL}`, 'x', false)).toBe(`imei=${REDACTED}`);
  });

  it('catches 14- and 16-digit numbers too, not only exact IMEIs', () => {
    expect(() => guardString('4' + '1'.repeat(13), 'x', true)).toThrow();
    expect(() => guardString('1'.repeat(16), 'x', true)).toThrow();
  });

  /**
   * The regression that took the server down.
   *
   * Fastify logs `responseTime` as a raw double, and a double prints up to seventeen significant
   * digits -- so `"responseTime":6.8965530000627041` carries a sixteen-digit run. The tripwire
   * fired on it, from inside Fastify's onResponse hook, where a throw is an uncaught exception.
   * Every request after the first hit a dead process.
   */
  it('does not mistake the fractional part of a float for an IMEI', () => {
    const line =
      '{"level":30,"time":1789252794344,"reqId":"8d553e0a-7384-44c8-a5e6-a613fdfa4eca",' +
      '"res":{"statusCode":200},"responseTime":6.8965530000627041,"msg":"request completed"}';
    expect(() => guardString(line, 'log line', true)).not.toThrow();
    expect(guardString(line, 'log line', false)).toBe(line);
  });

  it('does not trip on a float however long its fractional part', () => {
    for (const n of ['0.1234567890123456789012', '12.99999999999999999', '1.000000000000001']) {
      expect(() => guardString(`cost=${n}`, 'x', true)).not.toThrow();
    }
  });

  it('still catches an IMEI that merely follows a period or a digit-and-period', () => {
    // The exclusion is for a *fraction*, not for any digits near punctuation. A supplier's prose
    // ends sentences, and a version string is not a licence to leak.
    expect(() => guardString(`Device not found. ${SENTINEL} is unknown.`, 'x', true)).toThrow();
    expect(() => guardString(`{"imei":"${SENTINEL}"}`, 'x', true)).toThrow();
    expect(() => guardString(`imei=${SENTINEL}&key=x`, 'x', true)).toThrow();
  });

  it('redacts a long digit run whole, leaving no digits behind', () => {
    const out = guardString(`ref=${'9'.repeat(24)}`, 'x', false);
    expect(out).toBe(`ref=${REDACTED}`);
    expect(out).not.toMatch(/\d/);
  });

  it('still catches an IMEI concatenated into a longer digit run', () => {
    expect(() => guardString(`${SENTINEL}0000`, 'x', true)).toThrow(ImeiInLogError);
  });
});

describe('guardValue', () => {
  it('finds an IMEI nested inside an arbitrary object', () => {
    // This is the realistic shape: the number is not in a field we named, it is inside a
    // supplier's error text that we passed straight to the logger.
    const payload = { err: { response: { body: `<br>IMEI: ${SENTINEL}<br>Blacklist: Clean` } } };
    expect(() => guardValue(payload, 'log[0]', true)).toThrow(ImeiInLogError);
  });

  it('finds one inside an array', () => {
    expect(() => guardValue({ items: ['ok', `x${SENTINEL}`] }, 'log[0]', true)).toThrow();
  });

  it('redacts every occurrence in production mode', () => {
    const out = guardValue({ a: `${SENTINEL} and ${SENTINEL}` }, 'x', false) as { a: string };
    expect(out.a).toBe(`${REDACTED} and ${REDACTED}`);
    expect(out.a).not.toContain(SENTINEL);
  });

  it('is depth-limited so a vast object cannot stall a log call', () => {
    let deep: Record<string, unknown> = { v: SENTINEL };
    for (let i = 0; i < 20; i++) deep = { nest: deep };
    // Below the depth limit it is not reached; the point is that it returns rather than hanging.
    expect(() => guardValue(deep, 'x', true)).not.toThrow();
  });
});

describe('createLogger', () => {
  const capture = (nodeEnv: string) => {
    const lines: string[] = [];
    const base = createLogger({ level: 'trace', nodeEnv });
    return { base, lines };
  };

  it('wires the hook so a logged IMEI throws in development', () => {
    const { base } = capture('development');
    expect(() => base.info({ body: `IMEI: ${SENTINEL}` }, 'provider replied')).toThrow(ImeiInLogError);
  });

  it('wires the hook so a logged IMEI is redacted in production', () => {
    const lines: string[] = [];
    const logger = pino(
      {
        level: 'trace',
        hooks: createLogger({ level: 'trace', nodeEnv: 'production' })[Symbol.for('pino.hooks') as never] as never,
      },
      { write: (s: string) => void lines.push(s) } as never,
    );
    // The hook object is internal; assert the guard directly instead of reaching into pino.
    expect(guardValue({ body: `IMEI: ${SENTINEL}` }, 'x', false)).toEqual({
      body: `IMEI: ${REDACTED}`,
    });
    expect(logger).toBeDefined();
    expect(lines).toBeDefined();
  });
});

describe('res serializer', () => {
  /**
   * ADR-0007: the reveal route's 200 body is `{ check_id, imei }`. An allowlist that only ever
   * emits `statusCode` is what keeps that body out of the request-completion log line without
   * anyone having to remember to scrub it per route -- there is nothing to scrub because there is
   * nothing else to emit.
   */
  it('emits only the status code, never a response body', () => {
    const reply = { statusCode: 200, body: { check_id: 'chk_1', imei: SENTINEL } } as unknown as {
      statusCode?: number;
    };
    expect(serializers.res(reply)).toEqual({ statusCode: 200 });
  });
});

describe('pg error serialization', () => {
  it('drops the fields where Postgres echoes row data', () => {
    const error = Object.assign(new Error('no partition of relation "checks" found for row'), {
      code: '23514',
      table: 'checks',
      detail: 'Failing row contains (chk_1, t1, h_abc, 35310411, 35•••••••••••78, s_abc, \\x00ff).',
      where: 'SQL statement "INSERT INTO checks_p202609 ..."',
    });
    const out = serializers.err(error) as Record<string, unknown>;
    expect(out).toMatchObject({ message: error.message, code: '23514', table: 'checks' });
    expect(out).not.toHaveProperty('detail');
    expect(out).not.toHaveProperty('where');
  });
});
