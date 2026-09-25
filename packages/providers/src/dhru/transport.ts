import type { FailureReason, ProviderOutcome, RejectionReason } from '../types.js';
import { scrub } from '../normalise/extract.js';

/**
 * Shared HTTP plumbing for both DHRU generations.
 *
 * Everything here exists to make one guarantee: **a supplier's body never reaches a log, an error
 * message or an exception with an IMEI still in it.** Bodies are scrubbed at the point of receipt,
 * before anything can rethrow them.
 */

export interface HttpResult {
  readonly status: number;
  readonly body: string;
}

export class ProviderTransportError extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderTransportError';
  }
}

export async function postForm(
  url: string,
  form: Record<string, string>,
  signal: AbortSignal,
): Promise<HttpResult> {
  return send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal,
  });
}

export async function postJson(
  url: string,
  token: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<HttpResult> {
  return send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal,
  });
}

export async function getJson(url: string, token: string, signal: AbortSignal): Promise<HttpResult> {
  return send(url, { method: 'GET', headers: { authorization: `Bearer ${token}` }, signal });
}

async function send(url: string, init: RequestInit): Promise<HttpResult> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    // The URL is safe to name (it is ours), the request body is not -- it carries the IMEI.
    const aborted = init.signal?.aborted === true;
    throw new ProviderTransportError(
      aborted ? 'timeout' : 'transport_error',
      aborted ? 'provider request aborted' : `provider request failed: ${describe(cause)}`,
    );
  }

  // Scrubbed HERE, once, so no later code path can leak it by rethrowing.
  const body = scrub(await response.text());

  if (response.status === 401 || response.status === 403) {
    throw new ProviderTransportError('auth_error', 'provider rejected our credentials', response.status);
  }
  if (response.status === 429) {
    throw new ProviderTransportError('rate_limited', 'provider rate-limited us', response.status);
  }
  if (response.status >= 400) {
    throw new ProviderTransportError('http_error', `provider returned ${response.status}`, response.status);
  }
  return { status: response.status, body };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return scrub(cause.name);
  return 'unknown';
}

/** Maps a thrown transport error onto the outcome the router understands. */
export function toFailure(error: unknown): ProviderOutcome {
  if (error instanceof ProviderTransportError) {
    return {
      kind: 'failed',
      reason: error.reason,
      detail: scrub(error.message),
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'failed', reason: 'timeout', detail: 'provider request timed out' };
  }
  return { kind: 'failed', reason: 'transport_error', detail: 'provider call threw' };
}

/**
 * Supplier refusal phrases -> a rejection category.
 *
 * A rejection is an ANSWER ("we do not cover this device"), so it must not fail over and must not
 * be charged. An unrecognised refusal is deliberately NOT mapped to a benign default here: it
 * returns undefined and the caller treats it as a failure, which is the safe direction -- treating
 * an unknown supplier error as "device not supported" would render as a confident coverage claim.
 */
const REJECTIONS: ReadonlyArray<readonly [RegExp, RejectionReason]> = [
  [/not\s+support|unsupported\s+device|wrong\s+model/i, 'device_not_supported'],
  [/service\s+(is\s+)?(not\s+available|unavailable|disabled)/i, 'service_not_available_for_device'],
  [/not\s+found|no\s+record|no\s+result/i, 'device_not_found'],
  [/duplicate|already\s+(placed|ordered|exists)/i, 'duplicate_order'],
  [/invalid\s+imei|imei\s+(is\s+)?(invalid|not\s+valid)|wrong\s+imei/i, 'invalid_imei'],
];

export function classifyRejection(message: string): RejectionReason | undefined {
  return REJECTIONS.find(([pattern]) => pattern.test(message))?.[1];
}

/**
 * imei24 runs one job per API key; a second concurrent call is refused with this text rather than
 * a device answer. Checked BEFORE `classifyRejection` -- the refusal names no device, so treating
 * it as a rejection would misreport "we could not check you right now" as "this device is fine".
 * The regex tolerates imei24's actual spelling ("workign") as well as the correct one.
 */
export function classifyBusy(message: string): boolean {
  return /work(i|)g?n?\s+in\s+other\s+session|other\s+session/i.test(message);
}
