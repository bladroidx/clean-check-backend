import { randomBytes } from 'node:crypto';

/**
 * Tenant salt generation and validation.
 *
 * `subject.imei_hash` is `HMAC(tenant_salt, digits)`, and `Imei.hmac` refuses a key under 32 bytes
 * because the IMEI space is ~10^14 and enumerable in seconds -- a short key means the hash is not
 * pseudonymous at all, it is the number with extra steps.
 *
 * That guard was previously only reachable at check time, which made a weakly-salted tenant a
 * latent HTTP 500 on their first paid request and, worse, meant the pseudonymisation claim was
 * quietly false for them until someone noticed. The check belongs at creation: a tenant that
 * cannot be created is a fixable operational error, a tenant whose hashes are reversible is not.
 */

export const MIN_TENANT_SALT_BYTES = 32;

export class WeakTenantSalt extends RangeError {
  constructor(bytes: number) {
    super(
      `A tenant salt must be at least ${MIN_TENANT_SALT_BYTES} bytes, was ${bytes}. ` +
        `subject.imei_hash is HMAC(tenant_salt, digits); a short salt does not pseudonymise it.`,
    );
    this.name = 'WeakTenantSalt';
  }
}

export function generateTenantSalt(): string {
  return randomBytes(48).toString('base64');
}

export function assertStrongTenantSalt(salt: string): void {
  const bytes = Buffer.byteLength(salt, 'utf8');
  if (bytes < MIN_TENANT_SALT_BYTES) throw new WeakTenantSalt(bytes);
}
