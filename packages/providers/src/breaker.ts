/**
 * Per-provider circuit breaker.
 *
 * The failure this prevents is not latency, it is money. A supplier whose auth has silently
 * expired returns an error per call, and some of them debit the account anyway. Hammering it for
 * the length of an outage spends real credit on nothing, so the circuit opens on consecutive
 * failures and the router treats an open circuit as `unavailable(circuit_open)` -- a real answer,
 * not an error.
 *
 * Only `failed` outcomes count. A `rejected` is the supplier working correctly and saying no, and
 * counting it would take a healthy provider offline the moment someone checks a run of Samsungs
 * against an Apple-only service.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  readonly failureThreshold: number;
  readonly openMs: number;
  /** Successes needed in half-open before closing. One is enough to prove reachability. */
  readonly halfOpenSuccesses: number;
  readonly now?: () => number;
}

export const DEFAULT_BREAKER: Omit<BreakerOptions, 'now'> = {
  failureThreshold: 5,
  openMs: 60_000,
  halfOpenSuccesses: 1,
};

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private openedAtMs: number | undefined;
  private readonly now: () => number;

  constructor(
    readonly providerId: string,
    private readonly options: BreakerOptions = { ...DEFAULT_BREAKER },
  ) {
    this.now = options.now ?? Date.now;
  }

  state(): CircuitState {
    if (this.openedAtMs === undefined) return 'closed';
    return this.now() - this.openedAtMs >= this.options.openMs ? 'half_open' : 'open';
  }

  /** True when a call must not be attempted. Half-open lets exactly one probe through. */
  isOpen(): boolean {
    return this.state() === 'open';
  }

  recordSuccess(): void {
    if (this.state() === 'half_open') {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.options.halfOpenSuccesses) this.close();
      return;
    }
    this.close();
  }

  recordFailure(): void {
    if (this.state() === 'half_open') {
      // A failed probe restarts the full open window rather than retrying immediately.
      this.openedAtMs = this.now();
      this.halfOpenSuccesses = 0;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.openedAtMs = this.now();
      this.halfOpenSuccesses = 0;
    }
  }

  private close(): void {
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    this.openedAtMs = undefined;
  }

  snapshot(): { circuit: CircuitState; consecutiveFailures: number; openedAt?: Date } {
    return {
      circuit: this.state(),
      consecutiveFailures: this.consecutiveFailures,
      ...(this.openedAtMs !== undefined ? { openedAt: new Date(this.openedAtMs) } : {}),
    };
  }
}

export class BreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly options: BreakerOptions = { ...DEFAULT_BREAKER }) {}

  get(providerId: string): CircuitBreaker {
    let breaker = this.breakers.get(providerId);
    if (breaker === undefined) {
      breaker = new CircuitBreaker(providerId, this.options);
      this.breakers.set(providerId, breaker);
    }
    return breaker;
  }

  all(): CircuitBreaker[] {
    return [...this.breakers.values()];
  }
}
