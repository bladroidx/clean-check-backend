import { describe, expect, it } from 'vitest';
import { extractPairs, labelKey, pairsFromJson, scrub } from '../src/normalise/extract.js';
import { normalise, parseDate, valueKey, type Lexicon } from '../src/normalise/lexicon.js';
import { DHRU_BLACKLIST } from '../src/normalise/lexicons.js';

describe('extraction', () => {
  it('splits on the FIRST colon so a timestamp survives', () => {
    const pairs = extractPairs('Purchase Date: 2023-01-04 10:33<br>');
    expect(pairs).toEqual([{ label: 'Purchase Date', value: '2023-01-04 10:33' }]);
  });

  it('discards a line with no colon rather than guessing a label for it', () => {
    // A heading is not a fact. Inventing a label for it is how a stray word becomes a field value.
    expect(extractPairs('DEVICE REPORT<br>Model: iPhone 13')).toEqual([
      { label: 'Model', value: 'iPhone 13' },
    ]);
  });

  it('scrubs IMEI-shaped digits out of a raw value at the point of capture', () => {
    const pairs = extractPairs('IMEI: 353104112345676<br>Model: iPhone 13');
    expect(pairs[0]?.value).toBe('[REDACTED-IMEI]');
    expect(JSON.stringify(pairs)).not.toContain('353104112345676');
  });

  it('does not scrub a decimal, which is not an IMEI', () => {
    expect(scrub('cost 0.8965530000627041')).toBe('cost 0.8965530000627041');
  });

  it('flattens JSON to the same pair shape so both transports converge', () => {
    expect(pairsFromJson({ a: { b: 'c' } })).toEqual([{ label: 'a.b', value: 'c' }]);
  });

  it('treats case, spacing and punctuation as supplier styling', () => {
    expect(labelKey('Blacklist  Status:')).toBe(labelKey('blacklist_status'));
    expect(valueKey('  CLEAN!! ')).toBe('clean');
  });
});

describe('dates', () => {
  it('parses ISO and US forms', () => {
    expect(parseDate('2023-01-04')).toBe('2023-01-04T00:00:00.000Z');
    expect(parseDate('03/14/2022')).toBe('2022-03-14T00:00:00.000Z');
  });

  it('returns undefined for anything else rather than guessing', () => {
    expect(parseDate('sometime in 2023')).toBeUndefined();
    expect(parseDate('Unknown')).toBeUndefined();
  });
});

describe('extractPairs with imei24 semicolon lines', () => {
  it('splits Label;Value and keeps colons inside values', () => {
    const pairs = extractPairs('Mark;Alcatel \nModel;Idol3-4.7\nProduction Date;2015-09-21\nPurchase Date: 2023-01-04 10:33');
    expect(pairs).toEqual([
      { label: 'Mark', value: 'Alcatel' },
      { label: 'Model', value: 'Idol3-4.7' },
      { label: 'Production Date', value: '2015-09-21' },
      { label: 'Purchase Date', value: '2023-01-04 10:33' },
    ]);
  });

  it('drops empty values and keeps literal null for the lexicon to treat as absent', () => {
    expect(extractPairs('Model;\nWarranty Date;null')).toEqual([{ label: 'Warranty Date', value: 'null' }]);
  });

  it('scrubs an echoed IMEI line', () => {
    const [pair] = extractPairs(`IMEI;${'8'.repeat(15)}`);
    expect(pair?.value).toBe('[REDACTED-IMEI]');
  });
});

describe('the parsing rule', () => {
  it('never produces a value for an unrecognised status', () => {
    const { values, misses } = normalise(
      DHRU_BLACKLIST,
      extractPairs('Blacklist Status: Probably fine mate<br>'),
    );
    expect(values.get('blacklist.status')).toBeUndefined();
    expect(misses).toHaveLength(1);
  });

  /**
   * The asymmetry that keeps the drift alarm meaningful.
   *
   * "Blacklist Records: None" on a clean device is the supplier working correctly. If that raised
   * a lexicon miss, `imei_lexicon_miss_total` would fire on every clean handset and the alarm
   * would be muted within a week -- at which point it stops catching real drift.
   */
  it('treats a placeholder in a TEXT field as a known absence, silently', () => {
    const { values, misses } = normalise(
      DHRU_BLACKLIST,
      extractPairs('Blacklist Status: Clean<br>Blacklist Records: None<br>'),
    );
    expect(values.get('blacklist.status')?.value).toBe('clean');
    expect(values.get('blacklist.reported_by')).toBeUndefined();
    expect(misses).toEqual([]);
  });

  /**
   * The other half of the asymmetry. An enum is a DECIDING field -- it chooses the arm -- so an
   * unmatched value is loud whether or not it looks like a placeholder.
   */
  it('treats a placeholder in an ENUM field as unrecognised, loudly', () => {
    const { values, misses } = normalise(
      DHRU_BLACKLIST,
      extractPairs('Blacklist Status: Unknown<br>'),
    );
    expect(values.get('blacklist.status')).toBeUndefined();
    expect(misses).toEqual([
      expect.objectContaining({ field: 'blacklist.status', rawValue: 'Unknown' }),
    ]);
  });

  it('ignores a label it does not know, without noise', () => {
    // Suppliers pad responses with marketing lines; a warning per line buries the one that matters.
    const { misses } = normalise(
      DHRU_BLACKLIST,
      extractPairs('Powered by BestIMEI: buy credits now<br>Blacklist Status: Clean<br>'),
    );
    expect(misses).toEqual([]);
  });

  it('takes the first recognised occurrence when a field is repeated', () => {
    const { values } = normalise(
      DHRU_BLACKLIST,
      extractPairs('Blacklist Status: Blacklisted<br>Blacklist Status: Clean<br>'),
    );
    // The footer is usually the abbreviated one; the detailed answer comes first.
    expect(values.get('blacklist.status')?.value).toBe('blocked');
  });

  it('has no rule that maps a vague phrase to a good outcome', () => {
    // Guarding the lexicon itself, not just its behaviour: a future edit that adds
    // `"no records found" -> clean` without a fixture proving the supplier means it should be a
    // deliberate, visible act.
    const vague = ['no records found', 'nothing found', 'not in database', 'no data'];
    for (const entry of DHRU_BLACKLIST.entries) {
      for (const rule of entry.values ?? []) {
        expect(vague).not.toContain(valueKey(rule.match));
      }
    }
  });

  it('does not let one service’s lexicon answer for another', () => {
    const empty: Lexicon = { providerId: 'x', serviceId: 'y', entries: [] };
    const { values } = normalise(empty, extractPairs('Blacklist Status: Clean<br>'));
    expect(values.size).toBe(0);
  });
});
