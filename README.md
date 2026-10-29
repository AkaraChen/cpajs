# cpajs

pnpm monorepo for the `@cpajs/*` packages. Package documentation lives next to each package.

| Path | Package |
| --- | --- |
| [`packages/cpa`](packages/cpa) | [`@cpajs/cpa`](packages/cpa/README.md): run the official CLIProxyAPI from JavaScript and manage it with a typed client. |
| [`packages/codex-auth`](packages/codex-auth) | [`@cpajs/codex-auth`](packages/codex-auth/README.md): Sign in with ChatGPT (Codex device flow) and build the auth file CPA reads. Zero dependencies; not published by `release.yml` yet, see [docs/releasing-codex-auth.md](docs/releasing-codex-auth.md). |
| generated in `dist-npm/` | `@cpajs/<target>` platform packages that carry the CLIProxyAPI binaries, see [docs/platform-packages.md](docs/platform-packages.md). They are not workspace members. |

Package docs (API coverage, compatibility, migration, scope) are in `packages/cpa/docs/`. Repository-level files: `scripts/` (build, assemble, pack and publish tooling), `launcher/` (the Go `cpa-launcher`
shipped in the platform packages), `docs/`, and `.github/workflows/` (CI and release).

## Development

```sh
pnpm install
pnpm lint                  # Biome, whole repo
pnpm typecheck             # every package (scripts/ is checked as part of packages/cpa)
pnpm test                  # unit tests of every package
pnpm build                 # pnpm -r build
node scripts/build-binary.ts --target linux-x64-musl            # → dist-bin/
CPA_BINARY=$PWD/dist-bin/linux-x64-musl/cli-proxy-api pnpm test:e2e   # contract tests against real CPA
```

Package-level commands also work inside `packages/cpa` (for example `pnpm test:coverage`). The release scripts
are run from the repository root and are described in [packages/cpa/README.md](packages/cpa/README.md#development).
`pnpm panel:fetch` writes the bundled panel to `packages/cpa/assets/management.html`.

The release workflow packs `@cpajs/cpa` from `packages/cpa` and the platform packages from `dist-npm/`, so adding
another workspace package does not change what `release.yml` publishes until it is wired in explicitly.

Adding a package: create `packages/<name>/` with its own `package.json`; `pnpm-workspace.yaml` already matches `packages/*`.
