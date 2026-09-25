import type { FieldLexicon, Lexicon } from './lexicon.js';

/**
 * imei24 lexicons.
 *
 * KNOWN-BAD phrases only, taken from imei24's service names and API docs. There is deliberately
 * no known-good phrase anywhere in this file: none has been observed in a recorded response yet,
 * and a guessed "Clean" is the exact failure the parsing rule exists to prevent. Until fixtures
 * are recorded (spec §8), every good-looking answer is a miss -> inconclusive, which is safe.
 */

const BLACKLIST: FieldLexicon = {
  field: 'blacklist.status',
  labels: ['Blacklist Status', 'Blacklist', 'GSMA Status', 'Blacklist status', 'Lost/Stolen', 'Status'],
  values: [
    { match: 'blacklisted', value: 'blocked' },
    { match: 'lost', value: 'blocked' },
    { match: 'stolen', value: 'blocked' },
    { match: 'lost stolen', value: 'blocked' },
    { match: 'barred', value: 'blocked' },
  ],
};

const IDENTITY: readonly FieldLexicon[] = [
  { field: 'identity.manufacturer', labels: ['Mark', 'Brand', 'Manufacturer'] },
  { field: 'identity.model', labels: ['Model', 'Model Description', 'Device'] },
];

const PURCHASE: FieldLexicon = {
  field: 'warranty.purchase_date',
  labels: ['Purchase Date', 'Estimated Purchase Date', 'Warranty Date', 'Warranty Start Date'],
};

export const IMEI24_LEXICONS: readonly Lexicon[] = [
  { providerId: 'imei24', lexiconId: 'imei24-blacklist', entries: [BLACKLIST, ...IDENTITY] },
  {
    providerId: 'imei24',
    lexiconId: 'imei24-apple',
    entries: [
      BLACKLIST,
      {
        field: 'lock.activation.status',
        labels: ['Find My iPhone', 'FMI', 'FMI Status', 'iCloud Status', 'iCloud Lock'],
        values: [{ match: 'on', value: 'on' }, { match: 'enabled', value: 'on' }],
      },
      {
        field: 'lock.carrier.status',
        labels: ['SIM Lock', 'Simlock', 'SIM Lock Status', 'Carrier Lock'],
        values: [{ match: 'locked', value: 'locked' }],
      },
      { field: 'lock.carrier.network', labels: ['Carrier', 'Initial Carrier', 'Network'] },
      PURCHASE,
      ...IDENTITY,
    ],
  },
  {
    providerId: 'imei24',
    lexiconId: 'imei24-samsung',
    entries: [
      BLACKLIST,
      {
        field: 'lock.carrier.status',
        labels: ['SIM Lock', 'Simlock', 'Carrier Lock', 'Network Lock'],
        values: [{ match: 'locked', value: 'locked' }],
      },
      { field: 'lock.carrier.network', labels: ['Carrier', 'Sold By', 'Network'] },
      PURCHASE,
      ...IDENTITY,
    ],
  },
  {
    providerId: 'imei24',
    lexiconId: 'imei24-mdm',
    entries: [
      {
        field: 'lock.mdm.status',
        labels: ['MDM', 'MDM Status', 'MDM Lock'],
        values: [{ match: 'on', value: 'on' }, { match: 'enrolled', value: 'on' }],
      },
      ...IDENTITY,
    ],
  },
  { providerId: 'imei24', lexiconId: 'imei24-warranty', entries: [PURCHASE, ...IDENTITY] },
];
