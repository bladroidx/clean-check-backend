/**
 * The Type Allocation Code directory: the first eight digits of an IMEI to a device.
 *
 * Ported in shape from `check-this-phone/core/identity/.../TacDirectory.kt`, whose
 * `BundledTacDirectory` carries three demo entries. Replacing that stub is the whole point of the
 * free tier here.
 */

export interface TacEntry {
  readonly manufacturer: string;
  readonly model: string;
  readonly marketingName?: string;
  readonly deviceType?: string;
  /** Where this row came from. Higher `sourcePriority` wins a conflict. */
  readonly source: TacSource;
}

/**
 * `observed` outranks everything: it is a `(TAC -> model)` fact harvested from a paid provider
 * response, which we own outright with no licence attached. See ADR-0005.
 */
export type TacSource = 'observed' | 'paid' | 'osmocom' | 'bundled';

export const TAC_SOURCE_PRIORITY: Readonly<Record<TacSource, number>> = {
  observed: 100,
  paid: 50,
  osmocom: 10,
  bundled: 1,
};

export interface TacDirectory {
  lookup(tac: string): TacEntry | undefined;
  /**
   * The ingest version behind this directory, surfaced as `coverage.source_version`.
   * A result whose provenance cannot be named is not evidence.
   */
  readonly version: string;
  readonly size: number;
  /** Required by CC-BY-SA where Osmocom rows are present; harmless otherwise. */
  readonly attribution: string | undefined;
}

/**
 * The whole table in memory. ~250k rows at ~60 bytes is ~15 MB, which is what lets the free tier
 * answer in microseconds with zero database round trips — and that is what makes it safe to give
 * away.
 */
export class InMemoryTacDirectory implements TacDirectory {
  private constructor(
    private readonly entries: ReadonlyMap<string, TacEntry>,
    readonly version: string,
    readonly attribution: string | undefined,
  ) {}

  static from(
    rows: Iterable<readonly [string, TacEntry]>,
    version: string,
    attribution?: string,
  ): InMemoryTacDirectory {
    // Highest source priority wins, so an observed row is never overwritten by an Osmocom import.
    const merged = new Map<string, TacEntry>();
    for (const [tac, entry] of rows) {
      const existing = merged.get(tac);
      if (
        existing === undefined ||
        TAC_SOURCE_PRIORITY[entry.source] >= TAC_SOURCE_PRIORITY[existing.source]
      ) {
        merged.set(tac, entry);
      }
    }
    return new InMemoryTacDirectory(merged, version, attribution);
  }

  lookup(tac: string): TacEntry | undefined {
    return this.entries.get(tac);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Does the directory's idea of the device agree with what the holder says it is?
 *
 * Manufacturer only, case-insensitive — the deliberate looseness ported from `ImeiVerifier.kt`.
 * Comparing models would fail an honest phone, because a seller says "Galaxy S21" and the TAC
 * table says "SM-G991B".
 */
export function manufacturerMatches(entry: TacEntry, claimedManufacturer: string): boolean {
  return entry.manufacturer.trim().toLowerCase() === claimedManufacturer.trim().toLowerCase();
}
