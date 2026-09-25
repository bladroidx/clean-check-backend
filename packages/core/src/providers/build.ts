import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_LEXICONS, DhruLegacyProvider, loadCatalogueFile, type CatalogueService, type Provider } from '@imei-check/providers';

/**
 * Builds the provider set. Shared by the API and the worker (ADR-0006: nothing depends on apps/).
 *
 * A provider whose credentials are absent is NOT built -- and is named in `skipped` so `/readyz`
 * and the startup log say so. Zero providers is the supported free-only mode.
 *
 * It is not built-and-broken either, because a provider that exists but always fails would open
 * its own circuit, occupy a slot in the router's candidate list and turn every section into
 * `unavailable(provider_not_configured)` -- whereas not building it lets the next provider answer,
 * or lets the capability be honestly reported as having no coverage at all.
 */
export interface Imei24Credentials {
  readonly baseUrl: string;
  readonly username: string;
  readonly apiKey: string;
}

export interface BuiltProviders {
  readonly providers: Provider[];
  readonly catalogue: readonly CatalogueService[];
  /** Named so `/readyz` and the startup log can say which suppliers are absent and why. */
  readonly skipped: ReadonlyArray<{ providerId: string; reason: string }>;
}

export function buildProviders(opts: { catalogueDir: string; imei24?: Imei24Credentials }): BuiltProviders {
  const byProvider = loadCatalogues(opts.catalogueDir);
  const catalogue = [...byProvider.values()].flat();
  const providers: Provider[] = [];
  const skipped: Array<{ providerId: string; reason: string }> = [];

  const imei24 = byProvider.get('imei24') ?? [];
  if (opts.imei24 === undefined) {
    skipped.push({ providerId: 'imei24', reason: 'IMEI24_USERNAME/IMEI24_API_KEY not set' });
  } else if (imei24.length === 0) {
    skipped.push({ providerId: 'imei24', reason: 'no imei24 catalogue found' });
  } else {
    // imei24 documents DHRU compatibility: site address, account email as username, API key.
    providers.push(
      new DhruLegacyProvider({
        providerId: 'imei24',
        baseUrl: opts.imei24.baseUrl.replace(/\/+$/, ''),
        username: opts.imei24.username,
        apiAccessKey: opts.imei24.apiKey,
        services: imei24,
        lexicons: BUILTIN_LEXICONS,
      }),
    );
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
