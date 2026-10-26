/** The CLIProxyAPI release this package version is built and verified against. */
export const CPA_RELEASE = {
  version: '8.0.43',
  tag: 'v8.0.43',
  commit: '307803510bce87f986fcf7b1a84190f105c7b4aa',
  /** Commit timestamp, used as the reproducible build date. */
  commitDate: '2026-10-25T14:45:00Z',
  repository: 'https://github.com/router-for-me/CLIProxyAPI',
  /** Go toolchain required by the pinned go.mod. */
  goVersion: '1.26.10',
} as const;

/**
 * The web control panel (management.html) shipped in this package, from the
 * release that was current for {@link CPA_RELEASE}. scripts/fetch-panel.ts
 * downloads it at pack time and checks the digest; CPA serves it through
 * MANAGEMENT_STATIC_PATH instead of downloading the latest from GitHub.
 */
export const CPA_PANEL = {
  version: 'v1.26.7',
  repository: 'https://github.com/router-for-me/Cli-Proxy-API-Management-Center',
  url: 'https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/download/v1.26.7/management.html',
  sha256: '8c9c6b7d3fb311e6aad5d06e1993e53a2d28389e640448a1bc6304ed20b057b5',
} as const;
