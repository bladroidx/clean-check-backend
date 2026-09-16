import type { Capability } from '@imei-check/contract';
import { coversTac } from './catalogue.js';
import { extractPairs, pairsFromJson, scrub } from './normalise/extract.js';
import { normalise, type Lexicon } from './normalise/lexicon.js';
import type {
  CatalogueService,
  ExecuteRequest,
  Provider,
  ProviderOutcome,
} from './types.js';
import { classifyRejection, getJson, postJson, toFailure } from './dhru/transport.js';
import { fieldValues } from './dhru/assemble-fields.js';

/**
 * Generic IMEI24 adapter.
 *
 * The app is intentionally provider-agnostic: this adapter implements the same Provider contract
 * used by DHRU providers and returns canonical `ProviderOutcome` values, not IMEI24-specific ones.
 */
export interface Imei24Config {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly services: readonly CatalogueService[];
  readonly lexicons: readonly Lexicon[];
}

export class Imei24Provider implements Provider {
  readonly id: string;

  constructor(private readonly config: Imei24Config) {
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
        `${this.config.baseUrl}/check`,
        this.config.apiKey,
        {
          imei: request.imeiDigits,
          service_id: request.service.serviceId,
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

  async health(signal: AbortSignal): Promise<{ balanceUsd?: number; reachable: boolean }> {
    try {
      const result = await getJson(`${this.config.baseUrl}/account`, this.config.apiKey, signal);
      const parsed: unknown = JSON.parse(result.body);
      const balance = (parsed as { balance?: unknown } | null)?.balance;
      const numeric = typeof balance === 'string' ? Number.parseFloat(balance) : Number(balance);
      return Number.isFinite(numeric) ? { balanceUsd: numeric, reachable: true } : { reachable: true };
    } catch {
      return { reachable: false };
    }
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
    if (status === 'rejected' || status === 'cancelled' || status === 'error') {
      const detail = scrub(String(payload['message'] ?? payload['error'] ?? 'rejected'));
      return {
        kind: 'rejected',
        reason: classifyRejection(detail) ?? 'device_not_found',
        detail,
      };
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

    const candidate =
      payload['result'] ??
      payload['data'] ??
      payload['response'] ??
      payload['replay'];

    if (typeof candidate === 'string') {
      return this.normaliseBlob(scrub(candidate), service);
    }
    if (candidate !== null && typeof candidate === 'object') {
      const asPairs = this.normaliseJsonPairs(pairsFromJson(candidate));
      return this.normalisePairs(asPairs, service);
    }

    return { kind: 'failed', reason: 'malformed_response', detail: 'provider returned no result' };
  }

  private normaliseBlob(blob: string, service: CatalogueService): ProviderOutcome {
    return this.normalisePairs(extractPairs(blob), service);
  }

  private normaliseJsonPairs(pairs: ReturnType<typeof pairsFromJson>): ReturnType<typeof extractPairs> {
    return pairs.map((pair) => {
      const raw = pair.label.replace(/^.*\./, '').trim();
      const label = raw
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
      return {
        label: label.length > 0 ? label : pair.label,
        value: pair.value,
      };
    });
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
