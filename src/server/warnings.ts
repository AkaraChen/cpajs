/**
 * Warnings emitted by cpajs itself (not CPA's output, which goes to `onLog`).
 * Each has a stable code that can be suppressed individually.
 */
export type CpaWarningCode =
  /** No management key was given, so one was generated for this start. */
  | 'noManagementKey'
  /** `management.viaEnvironment`: plaintext comparison, and remote management is forced on. */
  | 'managementViaEnvironment'
  /** `management.allow-remote` is on and the server binds a non-loopback host. */
  | 'remoteManagementExposed'
  /** No cpa-launcher was found, so CPA can outlive this process. */
  | 'launcherMissing'
  /** An existing managed config was kept; this start's `config`, `host` and `port` were not applied. */
  | 'configReused'
  /** The management key in a reused config was replaced with the hash of a new key. */
  | 'managementKeyUpdated';

export interface CpaWarning {
  code: CpaWarningCode;
  message: string;
}

/** `{ noManagementKey: true }` silences that warning. */
export type SuppressWarnings = Partial<Record<CpaWarningCode, boolean>>;

/**
 * Returns a function that emits each warning code at most once: to `onWarning`
 * when given, otherwise through `process.emitWarning` (type `CpaWarning`), so it
 * shows up on stderr by default and works with Node's usual warning handling.
 */
export function createWarner(options: {
  suppressWarnings?: SuppressWarnings | undefined;
  onWarning?: ((warning: CpaWarning) => void) | undefined;
}): (code: CpaWarningCode, message: string) => void {
  const emitted = new Set<CpaWarningCode>();
  return (code, message) => {
    if (options.suppressWarnings?.[code] === true || emitted.has(code)) return;
    emitted.add(code);
    const warning: CpaWarning = { code, message: `${message} (suppress with suppressWarnings.${code})` };
    if (options.onWarning) options.onWarning(warning);
    else process.emitWarning(warning.message, { type: 'CpaWarning', code });
  };
}
