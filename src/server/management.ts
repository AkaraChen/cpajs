import { compare, hash } from 'bcryptjs';
import { CpaStartError } from './errors.ts';
import type { ManagementOptions } from './types.ts';

/** bcrypt cost; matches upstream's `bcrypt.DefaultCost` (about 50-100 ms per hash). */
export const BCRYPT_COST = 10;

// bcrypt only uses the first 72 bytes and upstream's Go implementation rejects
// longer passwords, so a hash of a longer key could never authenticate.
const MAX_BCRYPT_BYTES = 72;

export interface ResolvedManagement {
  /** The plaintext key, when the caller supplied one. */
  key: string | undefined;
  /** True when the key travels through `MANAGEMENT_PASSWORD`. */
  viaEnvironment: boolean;
  /** Value for `management.allow-remote` in a managed config. */
  allowRemote: boolean;
  /** bcrypt hash for `management.secret-key` (default mode only). */
  secretKeyHash: string | undefined;
}

/**
 * Normalises the management options and hashes the key for the default mode.
 * The deprecated `managementKey` alias maps to the same safe default, not to
 * the old `MANAGEMENT_PASSWORD` behaviour.
 */
export async function resolveManagement(options: {
  management?: ManagementOptions;
  managementKey?: string;
}): Promise<ResolvedManagement> {
  if (options.management !== undefined && options.managementKey !== undefined) {
    throw new CpaStartError(
      'invalid-options',
      'management and managementKey are mutually exclusive; managementKey is the deprecated alias for management.key.',
    );
  }
  const management =
    options.management ?? (options.managementKey === undefined ? undefined : { key: options.managementKey });
  if (management === undefined) {
    return {
      key: undefined,
      viaEnvironment: false,
      allowRemote: false,
      secretKeyHash: undefined,
    };
  }
  const key = management.key;
  if (typeof key !== 'string' || key.trim() === '') {
    throw new CpaStartError('invalid-options', 'management.key must not be empty.');
  }
  if (management.viaEnvironment === true) {
    // Upstream trims MANAGEMENT_PASSWORD, so trim here too: the handle exposes
    // the key that callers need for their client.
    const envKey = key.trim();
    return {
      key: envKey,
      viaEnvironment: true,
      allowRemote: management.allowRemote === true,
      secretKeyHash: undefined,
    };
  }
  if (Buffer.byteLength(key, 'utf8') > MAX_BCRYPT_BYTES) {
    throw new CpaStartError(
      'invalid-options',
      `management.key is longer than ${MAX_BCRYPT_BYTES} bytes, which bcrypt cannot represent. Use management.viaEnvironment: true for a longer key.`,
    );
  }
  return {
    key,
    viaEnvironment: false,
    allowRemote: management.allowRemote === true,
    secretKeyHash: await hash(key, BCRYPT_COST),
  };
}

const BCRYPT_HASH = /^\$2[aby]\$/;

/**
 * True when `stored` (a `management.secret-key` value) authenticates `key` the
 * way upstream checks it: bcrypt hashes are compared, a plaintext value is
 * hashed by CPA on load and so must equal the key.
 */
export async function keyMatches(key: string, stored: string | undefined): Promise<boolean> {
  if (stored === undefined) return false;
  return BCRYPT_HASH.test(stored) ? compare(key, stored) : stored === key;
}
