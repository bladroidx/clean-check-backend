import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_LEXICONS,
  DhruLegacyProvider,
  DhruRestProvider,
  Imei24Provider,
  loadCatalogueFile,
  type CatalogueService,
  type Provider,
} from '@imei-check/providers';
import type { Config } from '../config.js';

/**
 * Builds the provider set from configuration.
 *
 * A provider whose credentials are absent is simply **not built**. It is not built-and-broken,
 * because a provider that exists but always fails would open its own circuit, occupy a slot in the
 * router's candidate list and turn every section into `unavailable(provider_not_configured)` --
 * whereas not building it lets the next provider answer, or lets the capability be honestly
 * reported as having no coverage at all.
 *
 * Running with zero providers is a supported mode, not a misconfiguration: it is exactly the M0
 * free tier, and it costs nothing to operate.
 */

export interface BuiltProviders {
  readonly providers: Provider[];
  readonly catalogue: readonly CatalogueService[];
  /** Named so `/readyz` and the startup log can say which suppliers are absent and why. */
  readonly skipped: ReadonlyArray<{ providerId: string; reason: string }>;
}

export function buildProviders(config: Config): BuiltProviders {
  const providers: Provider[] = [];
  const skipped: Array<{ providerId: string; reason: string }> = [];
  const catalogue: CatalogueService[] = [];

  const byProvider = loadCatalogues(config.PROVIDER_CATALOGUE_DIR);
  for (const services of byProvider.values()) catalogue.push(...services);

  const alpha = byProvider.get('alpha');
  if (alpha !== undefined) {
    if (config.ALPHA_BASE_URL && config.ALPHA_USERNAME && config.ALPHA_API_KEY) {
      providers.push(
        new DhruLegacyProvider({
          providerId: 'alpha',
          baseUrl: config.ALPHA_BASE_URL.replace(/\/+$/, ''),
          username: config.ALPHA_USERNAME,
          apiAccessKey: config.ALPHA_API_KEY,
          services: alpha,
          lexicons: BUILTIN_LEXICONS,
        }),
      );
    } else {
      skipped.push({ providerId: 'alpha', reason: 'ALPHA_BASE_URL/USERNAME/API_KEY not set' });
    }
  }

  const beta = byProvider.get('beta');
  if (beta !== undefined) {
    if (config.BETA_BASE_URL && config.BETA_TOKEN) {
      providers.push(
        new DhruRestProvider({
          providerId: 'beta',
          baseUrl: config.BETA_BASE_URL.replace(/\/+$/, ''),
          token: config.BETA_TOKEN,
          services: beta,
          lexicons: BUILTIN_LEXICONS,
          ...(config.BETA_WEBHOOK_SECRET !== undefined
            ? { webhookSecret: config.BETA_WEBHOOK_SECRET }
            : {}),
        }),
      );
    } else {
      skipped.push({ providerId: 'beta', reason: 'BETA_BASE_URL/BETA_TOKEN not set' });
    }
  }

  const imei24 = byProvider.get('imei24');
  if (imei24 !== undefined) {
    if (config.IMEI24_BASE_URL && config.IMEI24_API_KEY) {
      providers.push(
        new Imei24Provider({
          providerId: 'imei24',
          baseUrl: config.IMEI24_BASE_URL.replace(/\/+$/, ''),
          apiKey: config.IMEI24_API_KEY,
          services: imei24,
          lexicons: BUILTIN_LEXICONS,
        }),
      );
    } else {
      skipped.push({ providerId: 'imei24', reason: 'IMEI24_BASE_URL/IMEI24_API_KEY not set' });
    }
  }

  return { providers, catalogue, skipped };
}

export function loadCatalogues(dir: string): Map<string, CatalogueService[]> {
  const byProvider = new Map<string, CatalogueService[]>();
  if (!existsSync(dir)) return byProvider;

  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    for (const service of loadCatalogueFile(join(dir, file))) {
      const existing = byProvider.get(service.providerId);
      if (existing === undefined) byProvider.set(service.providerId, [service]);
      else existing.push(service);
    }
  }
  return byProvider;
}

/** The public feedback URL an async supplier POSTs its result to. */
export function feedbackUrlFor(config: Config, providerId: string): string | undefined {
  if (config.PUBLIC_BASE_URL === undefined) return undefined;
  return `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/internal/providers/${providerId}/feedback`;
}
