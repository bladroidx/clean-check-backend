import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Capability } from '@imei-check/contract';
import { coversTac } from '../catalogue.js';
import { extractPairs, pairsFromJson, scrub } from '../normalise/extract.js';
import { normalise, type Lexicon } from '../normalise/lexicon.js';
import type {
  CatalogueService,
  ExecuteRequest,
  ParsedWebhook,
  Provider,
  ProviderOutcome,
  WebhookInput,
} from '../types.js';
import { classifyRejection, getJson, postJson, toFailure } from './transport.js';
import { fieldValues } from './assemble-fields.js';

/**
 * Modern DHRU reseller REST transport.
 *
 * Bearer token, `POST /order`, and an async `feedback_url` webhook carrying a base64 `replay`
 * payload. The webhook is the interesting half: it is an unauthenticated inbound POST from the
 * public internet claiming to be a supplier telling us an answer.
 *
 * It is treated as exactly that. `parseWebhook` verifies an HMAC over the raw bytes and yields a
 * `reference_id`; the caller then has to match that reference to an order IT created before any of
 * the payload is believed. Without both halves, anyone who learns the URL can post
 * `{"status":"success","replay":"<base64 of Blacklist: Clean>"}` and launder a stolen handset.
 */

export interface DhruRestConfig {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly token: string;
  /** Shared secret for the feedback signature. Absent means webhooks are refused, never trusted. */
  readonly webhookSecret?: string;
  readonly services: readonly CatalogueService[];
  readonly lexicons: readonly Lexicon[];
}

export class DhruRestProvider implements Provider {
  readonly id: string;

  constructor(private readonly config: DhruRestConfig) {
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
      const result = await postJson(
        `${this.config.baseUrl}/order`,
        this.config.token,
        {
          product_id: request.service.serviceId,
          imei: request.imeiDigits,
          reference_id: request.referenceId,
          ...(request.feedbackUrl !== undefined ? { feedback_url: request.feedbackUrl } : {}),
        },
        request.signal,
      );
      return this.interpret(result.body, request.service);
    } catch (error) {
      return toFailure(error);
    }
  }

  async poll(orderReference: string, signal: AbortSignal): Promise<ProviderOutcome> {
    const service = this.config.services[0];
    if (service === undefined) {
      return { kind: 'failed', reason: 'malformed_response', detail: 'provider has no services' };
    }
    try {
      const result = await getJson(
        `${this.config.baseUrl}/order/${encodeURIComponent(orderReference)}`,
        this.config.token,
        signal,
      );
      return this.interpret(result.body, service);
    } catch (error) {
      return toFailure(error);
    }
  }

  async health(signal: AbortSignal): Promise<{ balanceUsd?: number; reachable: boolean }> {
    try {
      const result = await getJson(`${this.config.baseUrl}/account`, this.config.token, signal);
      const parsed: unknown = JSON.parse(result.body);
      const balance = (parsed as { balance?: unknown } | null)?.balance;
      const numeric = typeof balance === 'string' ? Number.parseFloat(balance) : Number(balance);
      return Number.isFinite(numeric) ? { balanceUsd: numeric, reachable: true } : { reachable: true };
    } catch {
      return { reachable: false };
    }
  }

  /**
   * Verifies and decodes a feedback POST.
   *
   * Verification is over the RAW bytes, before any parsing: signing a re-serialised object checks
   * a signature against something the sender never sent.
   */
  async parseWebhook(input: WebhookInput): Promise<ParsedWebhook> {
    const secret = this.config.webhookSecret;
    if (secret === undefined || secret.length === 0) {
      throw new WebhookRejected('no webhook secret configured for this provider');
    }

    const header = input.headers['x-dhru-signature'];
    const supplied = Array.isArray(header) ? header[0] : header;
    if (typeof supplied !== 'string' || supplied.length === 0) {
      throw new WebhookRejected('missing signature header');
    }

    const expected = createHmac('sha256', secret).update(input.rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(supplied.trim().toLowerCase(), 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookRejected('signature did not verify');
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(input.rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new WebhookRejected('body was not JSON');
    }

    const referenceId = payload['reference_id'];
    if (typeof referenceId !== 'string' || referenceId.length === 0) {
      throw new WebhookRejected('no reference_id');
    }

    const service = this.config.services[0];
    if (service === undefined) throw new WebhookRejected('provider has no services');

    const status = String(payload['status'] ?? '').toLowerCase();
    if (status === 'rejected' || status === 'cancelled') {
      const detail = scrub(String(payload['message'] ?? 'provider rejected the order'));
      return {
        referenceId,
        outcome: {
          kind: 'rejected',
          reason: classifyRejection(detail) ?? 'device_not_found',
          detail,
        },
      };
    }

    const replay = payload['replay'];
    if (typeof replay !== 'string') throw new WebhookRejected('no replay payload');

    const decoded = scrub(Buffer.from(replay, 'base64').toString('utf8'));
    return { referenceId, outcome: this.normaliseBlob(decoded, service) };
  }

  interpret(body: string, service: CatalogueService): ProviderOutcome {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
      payload = parsed as Record<string, unknown>;
    } catch {
      return { kind: 'failed', reason: 'malformed_response', detail: 'provider body was not JSON' };
    }

    const status = String(payload['status'] ?? '').toLowerCase();

    if (status === 'rejected' || status === 'cancelled') {
      const detail = scrub(String(payload['message'] ?? 'rejected'));
      return { kind: 'rejected', reason: classifyRejection(detail) ?? 'device_not_found', detail };
    }
    if (status === 'pending' || status === 'processing' || status === 'in_progress') {
      const orderId = payload['order_id'] ?? payload['id'];
      if (typeof orderId !== 'string' && typeof orderId !== 'number') {
        return { kind: 'failed', reason: 'malformed_response', detail: 'pending order with no id' };
      }
      return {
        kind: 'pending',
        orderReference: String(orderId),
        providerCostUsd: service.costUsd,
      };
    }

    const result = payload['result'] ?? payload['replay'];
    if (typeof result === 'string') {
      const decoded = looksBase64(result) ? Buffer.from(result, 'base64').toString('utf8') : result;
      return this.normaliseBlob(scrub(decoded), service);
    }
    if (result !== null && typeof result === 'object') {
      return this.normalisePairs(pairsFromJson(result), service);
    }
    return { kind: 'failed', reason: 'malformed_response', detail: 'provider returned no result' };
  }

  private normaliseBlob(blob: string, service: CatalogueService): ProviderOutcome {
    return this.normalisePairs(extractPairs(blob), service);
  }

  private normalisePairs(
    pairs: ReturnType<typeof extractPairs>,
    service: CatalogueService,
  ): ProviderOutcome {
    const lexicon = this.config.lexicons.find((l) => l.serviceId === service.lexiconId);
    if (lexicon === undefined) {
      return {
        kind: 'failed',
        reason: 'malformed_response',
        detail: `no lexicon '${service.lexiconId}' registered for service ${service.serviceId}`,
      };
    }
    const { values, misses } = normalise(lexicon, pairs);
    return {
      kind: 'answered',
      fields: fieldValues(values, service.fields),
      misses,
      providerCostUsd: service.costUsd,
    };
  }
}

export class WebhookRejected extends Error {
  constructor(message: string) {
    super(`webhook rejected: ${message}`);
    this.name = 'WebhookRejected';
  }
}

const BASE64 = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

function looksBase64(value: string): boolean {
  return value.length > 16 && value.length % 4 === 0 && BASE64.test(value) && !value.includes(': ');
}
