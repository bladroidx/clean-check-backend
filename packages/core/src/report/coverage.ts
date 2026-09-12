import type { Capability, Coverage } from '@imei-check/contract';
import type { TacDirectory } from '@imei-check/identity';
import { GSMA_CAVEATS, identityCoverage } from './tac-coverage.js';

/**
 * Coverage for every capability, including the ones we could not answer.
 *
 * `coverage` is required on all four arms (invariant 6), and on `unavailable` it describes what a
 * successful answer WOULD have covered. That is deliberately more useful than null: a client can
 * tell the user "we could not reach the blocklist covering the US, GB and EU" rather than "we could
 * not reach something".
 *
 * Note what is never here: the provider's name. That is our supply chain, not the caller's.
 */

const GSMA_ENFORCED = ['US', 'GB', 'CA', 'AU', 'IE', 'FR', 'DE', 'ES', 'IT', 'NL', 'SE', 'NO'];
const GSMA_PARTIAL = ['BR', 'MX', 'IN', 'NG', 'ID', 'PH', 'PK', 'EG', 'ZA', 'TR'];

export function coverageFor(capability: Capability, tacDirectory: TacDirectory): Coverage {
  switch (capability) {
    case 'identity.model':
      return identityCoverage(tacDirectory);

    case 'blacklist.gsma':
      return {
        registries: ['GSMA IMEI Database (global block list)'],
        region_model: 'reporting_networks',
        enforced_in: GSMA_ENFORCED,
        partial_in: GSMA_PARTIAL,
        caveats: [...GSMA_CAVEATS],
      };

    case 'lock.carrier':
      return {
        registries: ['Carrier lock status (vendor records)'],
        region_model: 'vendor_records',
        enforced_in: ['*'],
        caveats: [
          'A lock released by the carrier can take up to 72 hours to appear in vendor records.',
          'Records cover devices sold through carrier channels; a device bought unlocked at retail ' +
            'may have no record either way.',
        ],
      };

    case 'lock.activation':
      return {
        registries: ['Vendor activation-lock records'],
        region_model: 'vendor_records',
        enforced_in: ['*'],
        caveats: [
          'Activation lock reflects the state at the moment it was read. A seller who signs out ' +
            'while you watch changes it immediately; a seller who signs back in afterwards ' +
            'changes it back.',
        ],
      };

    case 'lock.mdm':
      return {
        registries: ['Device enrolment records'],
        region_model: 'vendor_records',
        enforced_in: ['*'],
        caveats: [
          'Enrolment in an organisation can be added after sale; a clear result is not a ' +
            'guarantee the device will never enrol.',
        ],
      };

    case 'warranty.purchase_date':
    case 'warranty.status':
      return {
        registries: ['Vendor purchase records'],
        region_model: 'vendor_records',
        enforced_in: ['*'],
        caveats: [
          'The purchase date is the vendor record of first sale or first activation, which can ' +
            'differ from the date the current owner bought the device.',
        ],
      };

    case 'network.sold_by':
      return {
        registries: ['Vendor point-of-sale records'],
        region_model: 'vendor_records',
        enforced_in: ['*'],
        caveats: [
          'Identifies the original sales channel, not the current owner or any later reseller.',
        ],
      };
  }
}
