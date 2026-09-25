import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Imei24Credentials } from '@imei-check/core';

/**
 * Configuration, validated once at boot.
 *
 * The pepper guard is the point of this file. `Imei.saltedHash` refuses a blank salt, but that is
 * a per-call check on one code path; the length floor has to live at the only layer that can
 * enforce it for the whole process. A weak pepper is not a degraded mode -- the IMEI space is
 * ~10^14 and enumerable in seconds, so a weak pepper means the hashes are not pseudonymous at all.
 */

const MIN_PEPPER_BYTES = 32;

/**
 * The bundled seed, as an absolute path.
 *
 * A cwd-relative default would mean the process boots or not depending on which directory it was
 * started from: the image runs `node apps/api/dist/server.js` from the repo root, but
 * `npm run dev` delegates to the workspace and starts in `apps/api`. Three levels up is the repo
 * root from `apps/api/src` and from `apps/api/dist` alike, so this resolves the same either way.
 * An explicitly configured relative path stays relative to the cwd, as an operator would expect.
 */
const DEFAULT_TAC_SOURCE_FILE = fileURLToPath(
  new URL('../../../testdata/tac-seed.json', import.meta.url),
);

/** Same reasoning as the TAC seed path: identical from `apps/api/src` and `apps/api/dist`. */
const DEFAULT_CATALOGUE_DIR = fileURLToPath(
  new URL('../../../packages/providers/catalogue', import.meta.url),
);

const pepper = z
  .string()
  .refine((s) => Buffer.byteLength(s, 'utf8') >= MIN_PEPPER_BYTES, {
    message:
      `must be at least ${MIN_PEPPER_BYTES} bytes. A 15-digit space is enumerable in seconds, ` +
      `so a short pepper does not pseudonymise anything.`,
  });

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Internal cache / dedupe / abuse key material. Never returned to a caller. */
  SERVER_PEPPER: pepper,

  DATABASE_URL: z.string().url().optional(),

  /** Where the TAC directory is loaded from at boot. Relative paths resolve against the cwd. */
  TAC_SOURCE_FILE: z.string().default(DEFAULT_TAC_SOURCE_FILE),

  /** Directory of provider catalogue YAML. Absent means the free tier only, which is a valid mode. */
  PROVIDER_CATALOGUE_DIR: z.string().default(DEFAULT_CATALOGUE_DIR),

  /**
   * Public base URL, used to build the `feedback_url` an async supplier POSTs back to.
   * Wrong here means standard orders are placed and their answers land nowhere.
   */
  PUBLIC_BASE_URL: z.string().url().optional(),

  IMEI24_BASE_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), {
      message: 'IMEI24_BASE_URL must be https: the request body carries the API key and the IMEI',
    })
    .default('https://pro.imei24.com'),
  /** The imei24 account email (DHRU "username"). */
  IMEI24_USERNAME: z.string().optional(),
  IMEI24_API_KEY: z.string().optional(),
  /** Hard stop on supplier spend per UTC day, across API and worker. */
  IMEI24_DAILY_SPEND_USD: z.coerce.number().positive().default(10),
  /**
   * How long POST /v1/deep_checks waits for slow orders before handing off to polling. Must stay
   * below every caller's timeout: the Android app reads for 15 s and check-this-phone-backend
   * gives up after 20 s. A window longer than that means the phone times out while we still pay.
   * It is also the TOTAL budget for placing orders, so it has a floor: at 0 nothing would ever be
   * bought and every deep section would read "not attempted".
   */
  DEEP_CHECK_WAIT_MS: z.coerce.number().int().min(1_000).max(12_000).default(10_000),
  /** `version:base64key[,version:base64key]` -- ADR-0007. Enforced when DATABASE_URL is set. */
  IMEI_ENCRYPTION_KEYS: z.string().optional(),

  /** Free tier limits are licensing controls as much as abuse controls (ADR-0005). */
  RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Report every missing variable at once. A boot failure that reveals one problem per restart
    // wastes the operator's afternoon.
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}

/** `undefined` when the account isn't configured -- imei24 is then simply not built (a supported mode). */
export function imei24CredentialsFrom(config: Config): Imei24Credentials | undefined {
  if (!config.IMEI24_USERNAME || !config.IMEI24_API_KEY) return undefined;
  return { baseUrl: config.IMEI24_BASE_URL, username: config.IMEI24_USERNAME, apiKey: config.IMEI24_API_KEY };
}
