import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { DhruLegacyProvider, parseServicePrices } from '../src/dhru/legacy.js';
import { BUILTIN_LEXICONS } from '../src/normalise/lexicons.js';
import { classifyRejection, classifyBusy, ProviderTransportError, toFailure } from '../src/dhru/transport.js';
import type { CatalogueService } from '../src/types.js';

/**
 * The HTTP layer, against a mocked network.
 *
 * The behaviours that matter here are all about what happens when a supplier misbehaves, because
 * that is the normal case rather than the exception: a DHRU error arrives with HTTP 200, an auth
 * failure looks like an outage, and a response body may contain the IMEI we just sent.
 */

const BASE = 'https://supplier.invalid';
const SENTINEL = '353104112345676';

const service: CatalogueService = {
  serviceId: '12',
  providerId: 'dhru',
  displayName: 'blacklist',
  capabilities: ['blacklist.gsma'],
  fields: ['blacklist.status'],
  lexiconId: 'blacklist',
  costUsd: 0.12,
  credits: 3,
  async: false,
  timeoutMs: 5000,
  appliesToTacPrefixes: ['*'],
  enabled: true,
};

let agent: MockAgent;
let original: Dispatcher;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

function legacy(): DhruLegacyProvider {
  return new DhruLegacyProvider({
    providerId: 'dhru',
    baseUrl: BASE,
    username: 'u',
    apiAccessKey: 'k',
    services: [service],
    lexicons: BUILTIN_LEXICONS,
  });
}

function execute(provider: DhruLegacyProvider) {
  return provider.execute({
    capability: 'blacklist.gsma',
    service,
    imeiDigits: SENTINEL,
    signal: AbortSignal.timeout(5000),
    referenceId: 'ref-1',
  });
}

describe('legacy transport over HTTP', () => {
  it('posts the form and normalises the answer', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/index.php', method: 'POST' })
      .reply(200, { SUCCESS: [{ ID: '1', STATUS: 'Available', RESULT: 'Blacklist Status: Clean' }] });

    const outcome = await execute(legacy());
    expect(outcome.kind).toBe('answered');
  });

  it('sends the IMEI to the supplier (it has to) but never in a URL', async () => {
    let seenPath = '';
    let seenBody = '';
    agent
      .get(BASE)
      .intercept({ path: '/api/index.php', method: 'POST' })
      .reply(200, (options) => {
        seenPath = String(options.path);
        seenBody = String(options.body);
        return { SUCCESS: [{ STATUS: 'Available', RESULT: 'Blacklist Status: Clean' }] };
      });

    await execute(legacy());
    // The number reaches the supplier in the request BODY. A query string would land in their
    // access logs, every proxy in between, and ours.
    expect(seenPath).not.toContain(SENTINEL);
    expect(seenBody).toContain(SENTINEL);
  });

  it('maps 401 to auth_error rather than a generic outage', async () => {
    agent.get(BASE).intercept({ path: '/api/index.php', method: 'POST' }).reply(401, 'nope');
    const outcome = await execute(legacy());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toBe('auth_error');
  });

  it('maps 429 to rate_limited', async () => {
    agent.get(BASE).intercept({ path: '/api/index.php', method: 'POST' }).reply(429, 'slow down');
    const outcome = await execute(legacy());
    if (outcome.kind === 'failed') expect(outcome.reason).toBe('rate_limited');
  });

  it('maps 500 to http_error', async () => {
    agent.get(BASE).intercept({ path: '/api/index.php', method: 'POST' }).reply(500, 'boom');
    const outcome = await execute(legacy());
    if (outcome.kind === 'failed') expect(outcome.reason).toBe('http_error');
  });

  /** The realistic leak: a supplier echoes the number back inside their error text. */
  it('scrubs the IMEI out of a response body at the point of receipt', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/index.php', method: 'POST' })
      .reply(200, { ERROR: [{ MESSAGE: `Invalid IMEI ${SENTINEL} supplied` }] });

    const outcome = await execute(legacy());
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
    expect(outcome.kind).toBe('rejected');
  });

  it('a transport failure never becomes an answer', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/index.php', method: 'POST' })
      .replyWithError(new Error('ECONNREFUSED'));

    const outcome = await execute(legacy());
    expect(outcome.kind).toBe('failed');
    expect(JSON.stringify(outcome)).not.toContain('ECONNREFUSED');
  });

  it('reads the account balance for reconciliation', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/index.php', method: 'POST' })
      .reply(200, { SUCCESS: [{ credit: '42.50' }] });

    const health = await legacy().health(AbortSignal.timeout(5000));
    expect(health).toEqual({ balanceUsd: 42.5, reachable: true });
  });

  it('reports unreachable rather than throwing when health fails', async () => {
    agent.get(BASE).intercept({ path: '/api/index.php', method: 'POST' }).reply(500, '');
    expect(await legacy().health(AbortSignal.timeout(5000))).toEqual({ reachable: false });
  });

  it('reads the live price list from the nested DHRU imeiservicelist shape', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/index.php', method: 'POST' })
      .reply(200, {
        SUCCESS: [
          {
            MESSAGE: 'IMEI Service List',
            LIST: {
              Blacklist: {
                GROUPNAME: 'Blacklist',
                SERVICES: {
                  '486': { SERVICEID: 486, SERVICENAME: 'Global Blacklist checker', CREDIT: '0.10' },
                  '690': { SERVICEID: 690, SERVICENAME: 'Apple', CREDIT: 0.34 },
                },
              },
            },
          },
        ],
      });

    const prices = await legacy().servicePrices(AbortSignal.timeout(5000));
    expect(prices).toEqual(
      new Map([
        ['486', 0.1],
        ['690', 0.34],
      ]),
    );
  });

  /**
   * An unreadable list must not come back as an empty map: the drift job would read that as
   * "every service vanished" and switch the whole catalogue off on a supplier format change.
   */
  it('reports an unreadable price list as unknown, never as empty', async () => {
    agent.get(BASE).intercept({ path: '/api/index.php', method: 'POST' }).reply(200, { SUCCESS: [{ MESSAGE: 'ok' }] });
    expect(await legacy().servicePrices(AbortSignal.timeout(5000))).toBeUndefined();
    agent.get(BASE).intercept({ path: '/api/index.php', method: 'POST' }).reply(500, '');
    expect(await legacy().servicePrices(AbortSignal.timeout(5000))).toBeUndefined();
    agent.get(BASE).intercept({ path: '/api/index.php', method: 'POST' }).reply(200, { ERROR: [{ MESSAGE: 'Auth failed' }] });
    expect(await legacy().servicePrices(AbortSignal.timeout(5000))).toBeUndefined();
  });

  it('leaves out a price it cannot read strictly, rather than misreading a rise as a fall', () => {
    const prices = parseServicePrices(
      JSON.stringify({
        SUCCESS: [{ LIST: { g: { SERVICES: {
          a: { SERVICEID: 1, CREDIT: '0,75' },
          b: { SERVICEID: 2, CREDIT: '1,200.00' },
          c: { SERVICEID: 3, CREDIT: ' 0.10 ' },
          d: { SERVICEID: 4, CREDIT: '' },
        } } } }],
      }),
    );
    expect(prices).toEqual(new Map([['3', 0.1]]));
  });

  it('polls an open order for the service that placed it', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/index.php', method: 'POST' })
      .reply(200, { SUCCESS: [{ STATUS: 'Available', RESULT: 'Blacklist Status: Clean' }] });

    const outcome = await legacy().poll('order-1', service, AbortSignal.timeout(5000));
    expect(outcome.kind).toBe('answered');
  });
});

describe('failure classification', () => {
  it('maps a transport error onto a failed outcome', () => {
    const outcome = toFailure(new ProviderTransportError('timeout', 'timed out'));
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'timeout' });
  });

  it('an unknown throw is still a failure, never an answer', () => {
    expect(toFailure(new Error('???')).kind).toBe('failed');
    expect(toFailure('a string').kind).toBe('failed');
  });

  /**
   * An unrecognised refusal maps to UNDEFINED, so the caller treats it as a failure. Mapping it to
   * "device not supported" would turn a supplier's unknown error into a confident coverage claim.
   */
  it('does not invent a rejection category for an unrecognised message', () => {
    expect(classifyRejection('Something went terribly wrong')).toBeUndefined();
    expect(classifyRejection('Invalid IMEI')).toBe('invalid_imei');
    expect(classifyRejection('Device not supported')).toBe('device_not_supported');
  });

  /** imei24's actual spelling ("workign") and the correctly spelled form must both be caught. */
  it('recognises the one-job-at-a-time busy refusal under either spelling', () => {
    expect(classifyBusy('Your APIKEY is workign in other session. You can start again later')).toBe(
      true,
    );
    expect(classifyBusy('Your APIKEY is working in other session')).toBe(true);
    expect(classifyBusy('Invalid IMEI')).toBe(false);
  });
});
