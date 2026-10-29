import { buildCpaAuthFile, type BuildCpaAuthOptions } from './auth-file.ts';
import { type DeviceCode, loginWithDeviceCode, type WaitOptions } from './device.ts';
import type { CodexTokens } from './tokens.ts';

/**
 * Structural subset of `CpaClient` from @cpajs/cpa (client.credentials.upload), so this entry point has
 * no runtime or compile-time import of that package.
 */
export interface CredentialUploader {
  credentials: {
    upload(file: { name: string; content: Record<string, unknown> | string }, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
}

/**
 * Uploads the tokens as a CPA codex auth file. From then on CPA owns the refresh token and rotates it itself;
 * do not call refreshTokens() on the same token.
 */
export async function uploadToCpa(
  client: CredentialUploader,
  tokens: CodexTokens,
  options: BuildCpaAuthOptions & { signal?: AbortSignal } = {},
): Promise<{ name: string }> {
  const { signal, ...build } = options;
  const { name, content } = buildCpaAuthFile(tokens, build);
  await client.credentials.upload({ name, content }, signal ? { signal } : {});
  return { name };
}

/** Device login plus upload. Tokens never leave this function; only identifying metadata is returned. */
export async function loginAndUpload(
  client: CredentialUploader,
  options: WaitOptions & { onCode: (code: DeviceCode) => void | Promise<void>; build?: BuildCpaAuthOptions },
): Promise<{ name: string; email: string; accountId: string; planType: string }> {
  const { build, ...login } = options;
  const tokens = await loginWithDeviceCode(login);
  const { name } = await uploadToCpa(client, tokens, { ...build, ...(login.signal ? { signal: login.signal } : {}) });
  return {
    name,
    email: tokens.claims.email,
    accountId: tokens.claims.accountId,
    planType: tokens.claims.planType.trim() || 'free',
  };
}
