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
 * The imported directory with what we have learned on top (ADR-0005, "harvest our own").
 *
 * Every paid answer that names a device gives a `(TAC -> model)` observation we own outright. They live
 * in `tac_entries` and are held here in memory so the free tier still answers without a database
 * round trip: [replaceLearned] reloads them all (at boot, then periodically), [learn] adds one the
 * moment this process harvests it. An observation outranks every imported row, so a learned TAC is
 * answered from here and everything else falls through to [base].
 */
export class LearningTacDirectory implements TacDirectory {
  private learned = new Map<string, TacEntry>();

  constructor(private readonly base: TacDirectory) {}

  lookup(tac: string): TacEntry | undefined {
    return this.learned.get(tac) ?? this.base.lookup(tac);
  }

  learn(tac: string, entry: TacEntry): void {
    this.learned.set(tac, entry);
  }

  replaceLearned(rows: Iterable<readonly [string, TacEntry]>): void {
    this.learned = new Map(rows);
  }

  /** The base version, plus how many devices were learned once there are any. */
  get version(): string {
    return this.learned.size === 0 ? this.base.version : `${this.base.version}+observed.${this.learned.size}`;
  }

  get size(): number {
    let extra = 0;
    for (const tac of this.learned.keys()) if (this.base.lookup(tac) === undefined) extra += 1;
    return this.base.size + extra;
  }

  get attribution(): string | undefined {
    return this.base.attribution;
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
