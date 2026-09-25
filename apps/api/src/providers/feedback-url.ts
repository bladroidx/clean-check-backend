import type { Config } from '../config.js';

/** The public feedback URL an async supplier POSTs its result to. */
export function feedbackUrlFor(config: Config, providerId: string): string | undefined {
  if (config.PUBLIC_BASE_URL === undefined) return undefined;
  return `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/internal/providers/${providerId}/feedback`;
}
