/**
 * Test-only hooks. Nothing here is exported from the public entry points.
 *
 * `internalCommand` overrides how the CPA process is launched: the lifecycle
 * tests run a Node fixture through `process.execPath` because Windows does not
 * honour the fixture's shebang line. A Symbol key keeps it out of the typed
 * options and out of reach of plain-object options from JavaScript callers.
 */
export const internalCommand = Symbol('cpajs.internalCommand');

export interface InternalCommand {
  /** Executable to spawn instead of the resolved CPA binary. */
  path: string;
  /** Arguments placed before `-config <file>`. */
  args: readonly string[];
}
