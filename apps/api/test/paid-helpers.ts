import { InMemoryTacDirectory } from '@imei-check/identity';
import { MemoryRepositories, Metrics, type Repositories } from '@imei-check/core';
import type {
  CatalogueService,
  ExecuteRequest,
  ParsedWebhook,
  Provider,
  ProviderOutcome,
  WebhookInput,
} from '@imei-check/providers';
import { buildApp, type App } from '../src/app.js';
import { createLogger } from '../src/lib/log.js';
import { buildServices, type AppServices } from '../src/services.js';
import { generateApiKey } from '../src/auth/keys.js';

/**
 * Builds the whole paid stack in memory.
 *
 * No database, no network, no fixtures on disk. The point is that the money and contract logic can
 * be exercised exhaustively and fast -- and that a test which needs a Postgres container is a test
 * nobody runs before pushing.
 */

/** 48 bytes, as `generateTenantSalt` produces. A short one is now refused at creation. */
export const TENANT_SALT = 'dGVzdC10ZW5hbnQtc2FsdC00OC1ieXRlcy1sb25nLWZvci10ZXN0cw==';
export const PEPPER = Buffer.from('a'.repeat(48), 'utf8');

export function service(overrides: Partial<CatalogueService> = {}): CatalogueService {
  return {
    serviceId: 'svc-blacklist',
    providerId: 'fake',
    displayName: 'fake blacklist',
    capabilities: ['blacklist.gsma'],
    fields: ['blacklist.status'],
    lexiconId: 'blacklist',
    costUsd: 0.1,
    credits: 3,
    async: false,
    timeoutMs: 5000,
    appliesToTacPrefixes: ['*'],
    enabled: true,
    ...overrides,
  };
}

export class FakeProvider implements Provider {
  readonly executed: ExecuteRequest[] = [];
  outcome: ProviderOutcome;

  constructor(
    readonly id: string,
    outcome: ProviderOutcome,
    private readonly services: CatalogueService[] = [service({ providerId: id })],
    private readonly webhook?: (input: WebhookInput) => Promise<ParsedWebhook>,
  ) {
    this.outcome = outcome;
  }

  catalogue(): readonly CatalogueService[] {
    return this.services;
  }
  supports(capability: string): CatalogueService | undefined {
    return this.services.find((s) => (s.capabilities as readonly string[]).includes(capability));
  }
  async execute(request: ExecuteRequest): Promise<ProviderOutcome> {
    this.executed.push(request);
    return this.outcome;
  }
  /**
   * Declared as a real method rather than an optional field set to undefined: under
   * `exactOptionalPropertyTypes` an explicit `undefined` is not assignable to an optional method,
   * and a fake that does not typecheck against the interface is not testing the interface.
   */
  async parseWebhook(input: WebhookInput): Promise<ParsedWebhook> {
    if (this.webhook === undefined) throw new Error('this fake has no webhook parser');
    return this.webhook(input);
  }
}

export const CLEAN: ProviderOutcome = {
  kind: 'answered',
  fields: [{ field: 'blacklist.status', value: 'clean' }],
  misses: [],
};
export const BLOCKED: ProviderOutcome = {
  kind: 'answered',
  fields: [{ field: 'blacklist.status', value: 'blocked' }],
  misses: [],
};
export const REWORDED: ProviderOutcome = {
  kind: 'answered',
  fields: [],
  misses: [{ field: 'blacklist.status', rawValue: 'No records found', serviceId: 'svc-blacklist' }],
};
export const TIMEOUT: ProviderOutcome = { kind: 'failed', reason: 'timeout' };

export interface PaidHarness {
  readonly app: App;
  readonly repos: Repositories;
  readonly services: AppServices;
  readonly apiKey: string;
  readonly logs: { lines: string[]; raw(): string };
  auth(): { authorization: string };
}

export async function makePaidApp(options: {
  providers?: Provider[];
  /**
   * No-op: billing was removed entirely (single-consumer mode has no "on" state). Kept as an
   * accepted, ignored option so every existing call site did not need touching for a number that
   * no longer affects anything.
   */
  credits?: number;
} = {}): Promise<PaidHarness> {
  const lines: string[] = [];
  // The REAL logger, tripwire included -- a plain pino here would let an IMEI leak through a test.
  const logger = createLogger({
    level: 'trace',
    nodeEnv: 'test',
    destination: { write: (s: string) => void lines.push(s) },
  });

  const tacDirectory = InMemoryTacDirectory.from(
    [
      ['35310411', { manufacturer: 'Apple', model: 'iPhone 13', source: 'bundled' }],
      ['35847191', { manufacturer: 'Samsung', model: 'SM-G991B', source: 'bundled' }],
    ],
    'test-directory-1',
    'test attribution',
  );

  const repos = new MemoryRepositories();
  await repos.tenants.create({
    id: 'ten_test',
    name: 'Test tenant',
    plan: 'standard',
    status: 'active',
    imeiSalt: TENANT_SALT,
  });

  const key = generateApiKey(false);
  await repos.apiKeys.insert({
    id: 'key_1',
    tenantId: 'ten_test',
    prefix: key.prefix,
    keySha256: key.sha256,
    scopes: ['checks:write'],
    revokedAt: undefined,
    expiresAt: undefined,
  });

  const services = buildServices({
    repos,
    providers: options.providers ?? [new FakeProvider('fake', CLEAN)],
    metrics: new Metrics(false),
    pepper: PEPPER,
  });

  const app = await buildApp({ logger, tacDirectory, services });
  await app.ready();

  return {
    app,
    repos,
    services,
    apiKey: key.plaintext,
    logs: { lines, raw: () => lines.join('\n') },
    auth: () => ({ authorization: `Bearer ${key.plaintext}` }),
  };
}

let counter = 0;
export function idempotencyKey(): string {
  counter += 1;
  return `test-key-${counter}-${Date.now()}`;
}
