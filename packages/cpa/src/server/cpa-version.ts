/** The CLIProxyAPI release this package version is built and verified against. */
export const CPA_RELEASE = {
  version: '8.0.77',
  tag: 'v8.0.77',
  commit: 'a5e8f69e56309e1ef6d6872e667da81fdfbce2ce',
  /** Commit timestamp, used as the reproducible build date. */
  commitDate: '2026-11-17T22:17:42Z',
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
  version: 'v1.28.1',
  repository: 'https://github.com/router-for-me/Cli-Proxy-API-Management-Center',
  url: 'https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/download/v1.28.1/management.html',
  sha256: 'c00ac5577db8feb12d37de6ecb783cf919bb81536902308079f754337d7a7bc5',
} as const;
