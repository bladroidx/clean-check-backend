import pino, { type Logger, type LoggerOptions as PinoOptions } from 'pino';

/**
 * The IMEI tripwire.
 *
 * A pino `redact` path list is a hope, not a control: the realistic leak is an IMEI arriving
 * inside a supplier's free-text error message, and no path list can name that field in advance.
 * So every emitted string is scanned, and outside production the logger THROWS -- which is what
 * makes this a control rather than a safety net people learn to lean on.
 */

/**
 * "IMEI-shaped" means a WHOLE run of 14+ digits that is not the fractional part of a decimal.
 *
 * Both halves of that are load-bearing, and both were learned the hard way:
 *
 * - Anchoring to the start of the run (`(?<!\d)`) and taking all of it (`{14,}` rather than
 *   `{14,16}`) means a longer digit run is matched and redacted whole, instead of matching a
 *   16-digit window inside it and leaving the remaining digits in the line.
 * - Excluding a fraction (`(?<!\d\.)`) is what keeps the tripwire honest. Fastify logs
 *   `responseTime` as a raw double -- `"responseTime":6.8965530000627041` -- whose fractional
 *   part is sixteen digits. Under the old pattern EVERY request completed by a real HTTP server
 *   tripped the wire, and because that log call happens in Fastify's onResponse hook (a Node
 *   'finish' listener, outside any request error boundary) the throw was an uncaught exception
 *   that killed the process. The visible symptom was the worst kind: the first request returned
 *   a correct 200 and every one after it got ECONNREFUSED.
 *
 * A control that cries wolf on every single request is not a stricter control, it is one that
 * gets switched off. No real IMEI is ever written as the fractional part of a number.
 */
const IMEI_SHAPED = /(?<!\d)(?<!\d\.)\d{14,}/;
const IMEI_SHAPED_GLOBAL = /(?<!\d)(?<!\d\.)\d{14,}/g;
export const REDACTED = '[REDACTED-IMEI]';

export class ImeiInLogError extends Error {
  constructor(where: string) {
    super(
      `IMEI-shaped digits reached the logger via ${where}. Redact at the call site -- log ` +
        `imei.masked() or the hash, never the number.`,
    );
    this.name = 'ImeiInLogError';
  }
}

export function guardString(value: string, where: string, strict: boolean): string {
  if (!IMEI_SHAPED.test(value)) return value;
  if (strict) throw new ImeiInLogError(where);
  return value.replace(IMEI_SHAPED_GLOBAL, REDACTED);
}

/** Walks an arbitrary log payload. Depth-limited: a cyclic or vast object must not stall a log. */
export function guardValue(value: unknown, where: string, strict: boolean, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') return guardString(value, where, strict);
  if (Array.isArray(value)) return value.map((v) => guardValue(v, where, strict, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = guardValue(v, `${where}.${k}`, strict, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LoggerOptions {
  level: string;
  nodeEnv: string;
  /** Test destination. Production writes to stdout. */
  destination?: { write(chunk: string): void };
}

/**
 * Request and response serializers, by allowlist.
 *
 * Fastify's default `req` serializer reaches into the raw Node request, which carries the body --
 * under `inject()` that is literally `req.raw._lightMyRequest.payload`, and under a real server it
 * is whatever a framework or plugin has hung off the object. An allowlist is the only shape that
 * stays safe as those internals change: we name what may be logged rather than guessing what must
 * be stripped.
 */
/**
 * Exported so a test can assert the allowlist directly, without reaching into pino's internals to
 * prove a negative -- in particular that `res` never echoes a response body. That matters most on
 * `POST /v1/admin/checks/:id/imei/reveal` (ADR-0007): its 200 body carries the one thing that must
 * never land in a log line.
 */
export const serializers = {
  req(request: { id?: string; method?: string; url?: string }) {
    return { id: request.id, method: request.method, url: request.url?.split('?')[0] };
  },
  res(reply: { statusCode?: number }) {
    return { statusCode: reply.statusCode };
  },
} satisfies PinoOptions['serializers'];

export function createLogger(opts: LoggerOptions): Logger {
  const strict = opts.nodeEnv !== 'production';

  // The guard sits at the WRITE boundary, not in a log hook.
  //
  // A pino `hooks.logMethod` runs before serializers, so it inspects the raw Fastify request
  // rather than the line that would actually be written -- it would both miss what a serializer
  // adds and trip on what a serializer strips. Guarding the final string is the only position
  // that sees exactly what leaves the process, whatever produced it.
  const sink = opts.destination ?? process.stdout;
  const guarded = {
    write(line: string): void {
      sink.write(guardString(line, 'log line', strict));
    },
  };

  const options: PinoOptions = {
    level: opts.level,
    serializers,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["idempotency-key"]',
        'imei',
        '*.imei',
        'apiaccesskey',
        '*.apiaccesskey',
      ],
      censor: '[REDACTED]',
    },
  };

  return pino(options, guarded as never);
}
