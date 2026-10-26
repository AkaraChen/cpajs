import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Where the pinned control panel lives in the package (same depth from src/ and dist/). */
export const PANEL_FILE = fileURLToPath(new URL('../../assets/management.html', import.meta.url));

/** The bundled control panel, or undefined in a checkout where it was not fetched. */
export function bundledPanel(): string | undefined {
  return existsSync(PANEL_FILE) ? PANEL_FILE : undefined;
}
