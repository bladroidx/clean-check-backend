import type { Capability } from '@imei-check/contract';
import { coversTac } from '../catalogue.js';
import { extractPairs, scrub } from '../normalise/extract.js';
import { normalise, type Lexicon } from '../normalise/lexicon.js';
import type {
  CatalogueService,
  ExecuteRequest,
  Provider,
  ProviderOutcome,
} from '../types.js';
import { classifyBusy, classifyRejection, postForm, toFailure, ProviderTransportError } from './transport.js';
import { fieldValues } from './assemble-fields.js';

/**
 * Legacy DHRU Fusion transport.
 *
 * A form POST to `/api/index.php` carrying `username` / `apiaccesskey` / `action`, answered with
 * JSON whose useful payload is an HTML fragment inside a string field. It is an ugly protocol and
 * it is what most of the supply actually speaks.
 *
 * Two details that are not obvious from anyone's documentation and cost real money to learn:
 *
 * 1. **A DHRU error is HTTP 200.** `{"ERROR":[{"MESSAGE":"Invalid IMEI"}]}` arrives with a 200
 *    status, so status-code-only error handling reports every refusal as a success and then finds
 *    no fields in it.
 * 2. **`STATUS` is the order's state, not the answer.** `Available` means the result is ready;
 *    `Pending` means come back in hours. Reading `RESULT` without checking `STATUS` yields an
 *    empty blob that normalises to nothing and looks exactly like a clean device.
 * 3. **imei24's instant-style responses arrive flat, not wrapped in `ERROR`/`SUCCESS`.** A refusal
 *    looks like `{"STATUS":"error","MESSAGE":"..."}` at the top level, and one specific message --
 *    the one-job-at-a-time refusal -- names no device at all, so it must be classified as a
 *    transport-level `rate_limited` failure rather than a rejection or, worse, an answer.
 * 4. **The standard `placeimeiorder` success is an acknowledgement, not an answer.**
 *    `{"SUCCESS":[{"MESSAGE":"Order received","REFERENCEID":"…"}]}` has no STATUS and no result.
 *    Read as an answer it yields zero fields: the order we paid for is never polled and the next
 *    check buys it again. So a SUCCESS with a REFERENCEID, no order STATUS and nothing parseable
 *    is `pending(REFERENCEID)` for every service, sync or not (ruling R16) -- a poll is cheap, a
 *    discarded paid order is not.
 */

export interface DhruLegacyConfig {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly username: string;
  readonly apiAccessKey: string;
  readonly services: readonly CatalogueService[];
  readonly lexicons: readonly Lexicon[];
}

interface DhruEnvelope {
  SUCCESS?: unknown;
  ERROR?: unknown;
}

export class DhruLegacyProvider implements Provider {
  readonly id: string;

  constructor(private readonly config: DhruLegacyConfig) {
    this.id = config.providerId;
  }

  catalogue(): readonly CatalogueService[] {
    return this.config.services;
  }

  supports(capability: Capability, tac: string): CatalogueService | undefined {
    return this.config.services.find(
      (s) => s.enabled && s.capabilities.includes(capability) && coversTac(s, tac),
    );
  }

  async execute(request: ExecuteRequest): Promise<ProviderOutcome> {
    try {
      const result = await postForm(
        `${this.config.baseUrl}/api/index.php`,
        {
          username: this.config.username,
          apiaccesskey: this.config.apiAccessKey,
          action: 'placeimeiorder',
          format: 'json',
          requestformat: 'json',
          services: request.service.serviceId,
          imei: request.imeiDigits,
          reference: request.referenceId,
        },
        request.signal,
      );
      return this.interpret(result.body, request.service);
    } catch (error) {
      return toFailure(error);
    }
  }

  async poll(
    orderReference: string,
    service: CatalogueService,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    try {
      const result = await postForm(
        `${this.config.baseUrl}/api/index.php`,
        {
          username: this.config.username,
          apiaccesskey: this.config.apiAccessKey,
          action: 'getimeiorder',
          format: 'json',
          requestformat: 'json',
          id: orderReference,
        },
        signal,
      );
      return this.interpret(result.body, service);
    } catch (error) {
      return toFailure(error);
    }
  }

  async health(signal: AbortSignal): Promise<{ balanceUsd?: number; reachable: boolean }> {
    try {
      const result = await postForm(
        `${this.config.baseUrl}/api/index.php`,
        {
          username: this.config.username,
          apiaccesskey: this.config.apiAccessKey,
          action: 'accountinfo',
          format: 'json',
          requestformat: 'json',
        },
        signal,
      );
      const record = firstSuccess(parseEnvelope(result.body));
      const balance = record?.['credit'] ?? record?.['balance'];
      const parsed = typeof balance === 'string' ? Number.parseFloat(balance) : Number(balance);
      return Number.isFinite(parsed) ? { balanceUsd: parsed, reachable: true } : { reachable: true };
    } catch {
      return { reachable: false };
    }
  }

  /** The one place a legacy body becomes an outcome. Kept separate so fixtures can drive it. */
  interpret(body: string, service: CatalogueService): ProviderOutcome {
    let envelope: DhruEnvelope;
    try {
      envelope = parseEnvelope(body);
    } catch {
      return { kind: 'failed', reason: 'malformed_response', detail: 'provider body was not JSON' };
    }

    // Point 1 above: an error arrives with HTTP 200.
    const error = firstOf(envelope.ERROR);
    if (error !== undefined) {
      const message = scrub(String(error['MESSAGE'] ?? error['message'] ?? 'provider error'));
      if (classifyBusy(message)) {
        return { kind: 'failed', reason: 'rate_limited', detail: 'supplier is busy with another job' };
      }
      const rejection = classifyRejection(message);
      return rejection !== undefined
        ? { kind: 'rejected', reason: rejection, detail: message }
        : { kind: 'failed', reason: 'http_error', detail: message };
    }

    // Point 3 above: imei24's instant-style refusal is a FLAT body, not wrapped in ERROR/SUCCESS.
    const flat = envelope as Record<string, unknown>;
    if (String(flat['STATUS'] ?? '').toLowerCase() === 'error') {
      const message = scrub(String(flat['MESSAGE'] ?? 'provider error'));
      if (classifyBusy(message)) {
        return { kind: 'failed', reason: 'rate_limited', detail: 'supplier is busy with another job' };
      }
      const rejection = classifyRejection(message);
      return rejection !== undefined
        ? { kind: 'rejected', reason: rejection, detail: message }
        : { kind: 'failed', reason: 'http_error', detail: message };
    }

    const record = firstSuccess(envelope);
    if (record === undefined) {
      return { kind: 'failed', reason: 'malformed_response', detail: 'provider returned no result' };
    }

    // Point 2 above: STATUS is the ORDER state. Reading RESULT without it is how an empty blob
    // becomes a clean-looking answer.
    const status = String(record['STATUS'] ?? record['status'] ?? '').toLowerCase();
    if (status.includes('pending') || status.includes('progress') || status.includes('waiting')) {
      const reference = String(record['ID'] ?? record['REFERENCEID'] ?? record['id'] ?? '');
      if (reference.length === 0) {
        return { kind: 'failed', reason: 'malformed_response', detail: 'pending order with no id' };
      }
      return { kind: 'pending', orderReference: reference, providerCostUsd: service.costUsd };
    }
    if (status.includes('reject') || status.includes('cancel')) {
      const message = scrub(String(record['RESULT'] ?? record['MESSAGE'] ?? 'rejected'));
      return {
        kind: 'rejected',
        reason: classifyRejection(message) ?? 'device_not_found',
        detail: message,
      };
    }

    // Point 4 above: the standard placement acknowledgement has no STATUS and no result, only a
    // REFERENCEID. Anything with no parseable result below is that order still running.
    const placedReference =
      status.length === 0 ? String(record['REFERENCEID'] ?? record['referenceid'] ?? '') : '';
    const placed: ProviderOutcome | undefined =
      placedReference.length > 0
        ? { kind: 'pending', orderReference: placedReference, providerCostUsd: service.costUsd }
        : undefined;

    const blob = record['RESULT'] ?? record['result'] ?? record['MESSAGE'];
    if (typeof blob !== 'string' || blob.trim().length === 0) {
      return placed ?? { kind: 'failed', reason: 'malformed_response', detail: 'provider returned an empty result' };
    }

    const lexicon = this.config.lexicons.find(
      (l) => l.providerId === this.id && l.lexiconId === service.lexiconId,
    );
    if (lexicon === undefined) {
      // No lexicon means every value is unrecognised. Saying so is honest; guessing is not.
      return {
        kind: 'failed',
        reason: 'malformed_response',
        detail: `no lexicon '${service.lexiconId}' registered for service ${service.serviceId}`,
      };
    }

    const { values, misses } = normalise(lexicon, extractPairs(blob));
    // "Order received" normalises to nothing at all -- not a miss, not a field. With a REFERENCEID
    // that is a placed order to poll; read as an answer it would be an empty (paid) non-answer.
    if (placed !== undefined && values.size === 0 && misses.length === 0) return placed;
    return {
      kind: 'answered',
      fields: fieldValues(values, service.fields),
      misses,
      providerCostUsd: service.costUsd,
    };
  }
}

function parseEnvelope(body: string): DhruEnvelope {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== 'object') {
    throw new ProviderTransportError('malformed_response', 'provider body was not an object');
  }
  return parsed as DhruEnvelope;
}

/**
 * DHRU wraps everything in single-element arrays, and different sellers nest one level deeper.
 * Both shapes are real; neither is documented.
 */
function firstOf(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    const head: unknown = value[0];
    return head !== null && typeof head === 'object' ? (head as Record<string, unknown>) : undefined;
  }
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
  return undefined;
}

function firstSuccess(envelope: DhruEnvelope): Record<string, unknown> | undefined {
  const outer = firstOf(envelope.SUCCESS);
  if (outer === undefined) return undefined;
  // `{"SUCCESS":[{"1":{...}}]}` -- keyed by order index rather than listed.
  if (outer['STATUS'] === undefined && outer['RESULT'] === undefined) {
    const nested = Object.values(outer).find((v) => v !== null && typeof v === 'object');
    if (nested !== undefined) return nested as Record<string, unknown>;
  }
  return outer;
}
