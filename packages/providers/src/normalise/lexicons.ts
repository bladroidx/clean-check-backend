import type { Lexicon } from './lexicon.js';

/**
 * The shipped lexicons.
 *
 * Every rule here was derived from a recorded fixture, never from a supplier's documentation --
 * the documentation describes what they meant to send. See
 * `.claude/skills/fixture-recording/SKILL.md`.
 *
 * Note what is NOT here: any rule mapping a vague value to a good outcome. There is no
 * `"no records found" -> clean` because no fixture has yet proved a supplier means that by it,
 * and guessing in this direction is precisely the failure mode the lexicon exists to prevent.
 * When one does appear it arrives as a miss, with the phrase, and someone adds it deliberately.
 */

const BLACKLIST_LABELS = [
  'Blacklist Status',
  'Blacklist',
  'GSMA Blacklist Status',
  'Black List Status',
  'Status',
  'Blacklisted',
];

/** Clean and blocked, each stated positively. Nothing infers one from the absence of the other. */
const BLACKLIST_VALUES = [
  { match: 'clean', value: 'clean' },
  { match: 'clear', value: 'clean' },
  { match: 'not blacklisted', value: 'clean' },
  { match: 'not found in blacklist', value: 'clean' },
  { match: 'no blacklist record', value: 'clean' },
  { match: 'blacklisted', value: 'blocked' },
  { match: 'blocked', value: 'blocked' },
  { match: 'barred', value: 'blocked' },
  { match: 'lost', value: 'blocked' },
  { match: 'stolen', value: 'blocked' },
  { match: 'lost stolen', value: 'blocked' },
  { match: 'blacklisted lost', value: 'blocked' },
  { match: 'blacklisted stolen', value: 'blocked' },
];

export const DHRU_BLACKLIST: Lexicon = {
  providerId: 'dhru',
  serviceId: 'blacklist',
  entries: [
    { field: 'blacklist.status', labels: BLACKLIST_LABELS, values: BLACKLIST_VALUES },
    {
      field: 'blacklist.reported_by',
      labels: ['Blacklist Records', 'Reported By', 'Blacklisted By', 'Carrier'],
    },
    { field: 'blacklist.reported_at', labels: ['Blacklist Date', 'Reported On', 'Date Reported'] },
    { field: 'identity.manufacturer', labels: ['Brand', 'Manufacturer', 'Make'] },
    { field: 'identity.model', labels: ['Model', 'Model Description', 'Device'] },
  ],
};

/**
 * `lock.activation.status` -- the polarity trap, in one table.
 *
 * "Clean" here means the lock is OFF, the opposite sentiment to "clean" in `blacklist.status`.
 * That is exactly why polarity is never inferred from a word and every rule names its value.
 */
export const DHRU_APPLE: Lexicon = {
  providerId: 'dhru',
  serviceId: 'apple-basic',
  entries: [
    {
      field: 'lock.activation.status',
      labels: ['Find My iPhone', 'FMI Status', 'FMI', 'iCloud Status', 'iCloud Lock', 'Activation Lock'],
      values: [
        { match: 'on', value: 'on' },
        { match: 'locked', value: 'on' },
        { match: 'lock', value: 'on' },
        { match: 'enabled', value: 'on' },
        { match: 'active', value: 'on' },
        { match: 'off', value: 'off' },
        { match: 'unlocked', value: 'off' },
        { match: 'clean', value: 'off' },
        { match: 'disabled', value: 'off' },
      ],
    },
    {
      field: 'lock.mdm.status',
      labels: ['MDM Lock', 'MDM Status', 'Device Enrollment', 'DEP Status'],
      values: [
        { match: 'on', value: 'on' },
        { match: 'enrolled', value: 'on' },
        { match: 'locked', value: 'on' },
        { match: 'off', value: 'off' },
        { match: 'not enrolled', value: 'off' },
        { match: 'clean', value: 'off' },
      ],
    },
    {
      field: 'lock.carrier.status',
      labels: ['SIM Lock', 'SIM Lock Status', 'Carrier Lock', 'Lock Status', 'Simlock'],
      values: [
        { match: 'locked', value: 'locked' },
        { match: 'lock', value: 'locked' },
        { match: 'unlocked', value: 'unlocked' },
        { match: 'unlock', value: 'unlocked' },
        { match: 'clean', value: 'unlocked' },
      ],
    },
    { field: 'lock.carrier.network', labels: ['Carrier', 'Network', 'Carrier Name', 'Next Tether Policy'] },
    { field: 'warranty.purchase_date', labels: ['Purchase Date', 'Estimated Purchase Date', 'Activation Date'] },
    { field: 'network.sold_by', labels: ['Sold By', 'Sold To', 'Purchase Country', 'Country'] },
    { field: 'identity.manufacturer', labels: ['Brand', 'Manufacturer'] },
    { field: 'identity.model', labels: ['Model', 'Model Description', 'Device Name', 'Model Name'] },
  ],
};

export const BUILTIN_LEXICONS: readonly Lexicon[] = [DHRU_BLACKLIST, DHRU_APPLE];

export function lexiconFor(providerId: string, serviceId: string): Lexicon | undefined {
  return BUILTIN_LEXICONS.find((l) => l.providerId === providerId && l.serviceId === serviceId);
}
