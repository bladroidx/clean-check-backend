/**
 * Keeps the raw request bytes for routes that verify a signature over them.
 *
 * A supplier signs the bytes it sent. Fastify's JSON parser hands the route a parsed object, and
 * re-serialising that object produces different bytes -- different key order, different number
 * formatting, no insignificant whitespace. Verifying against the re-serialisation checks a
 * signature over something the sender never transmitted, which either fails constantly or, worse,
 * is "fixed" by skipping verification.
 *
 * Only applied to the provider feedback route, because holding the raw buffer for every request
 * doubles the memory a large body costs.
 */

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const FEEDBACK_PATH = /^\/internal\/providers\/[^/]+\/feedback$/;

/**
 * Structural, not `FastifyInstance`: the app is typed with a concrete pino logger and a zod type
 * provider, and naming the full instance type here would couple this helper to both.
 */
interface ParserHost {
  addContentTypeParser(
    contentType: string,
    options: { parseAs: 'buffer' },
    handler: (
      request: { url: string; rawBody?: Buffer },
      body: Buffer,
      done: (error: Error | null, result?: unknown) => void,
    ) => void,
  ): unknown;
}

export function registerRawBody(app: ParserHost): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      if (FEEDBACK_PATH.test(request.url.split('?')[0] ?? '')) request.rawBody = body;
      if (body.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body.toString('utf8')) as unknown);
      } catch {
        // A malformed body is a 400 from the framework, not a crash, and the body is never echoed.
        const error = Object.assign(new Error('Body is not valid JSON.'), { statusCode: 400 });
        done(error, undefined);
      }
    },
  );
}
