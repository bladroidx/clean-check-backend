import { InMemoryTacDirectory } from '@imei-check/identity';
import { buildApp, type App } from '../src/app.js';
import { createLogger } from '../src/lib/log.js';

/** Luhn-valid, allocated to nobody. Used to prove no raw IMEI survives anywhere. */
export const SENTINEL = '353104112345676';
export const UNKNOWN_TAC_IMEI = '999999990000008';

export interface CapturedLogs {
  lines: string[];
  raw(): string;
}

/** `extra` registers additional routes before ready(), for exercising the error handler. */
export async function makeApp(extra?: (app: App) => void): Promise<{ app: App; logs: CapturedLogs }> {
  const lines: string[] = [];
  // The REAL logger, tripwire included -- a plain pino here would let a leak through the test.
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

  const app = await buildApp({ logger, tacDirectory });
  extra?.(app);
  await app.ready();
  return { app, logs: { lines, raw: () => lines.join('\n') } };
}
