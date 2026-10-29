# Releasing @cpajs/codex-auth

`release.yml` publishes `@cpajs/cpa` and the platform packages only. `@cpajs/codex-auth` is deliberately **not** in its publish step:
npm trusted publishing (OIDC) can only be configured for a package that already exists, so the first publish is manual.

## First publish (maintainer)

1. Check that `packages/codex-auth/package.json` has the version you want (it follows `@cpajs/cpa`).
2. From the repository root: `pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm test`.
3. Inspect the tarball: `cd packages/codex-auth && npm pack --dry-run` (expect `dist/`, `src/` without tests, `README.md`, `LICENSE`, `CHANGELOG.md`).
4. Publish with your own npm account (2FA): `cd packages/codex-auth && npm publish --access public --tag rc` (use the dist-tag matching the
   version, as for `@cpajs/cpa`). `prepack` builds first.
5. Configure trusted publishing for the new package, either in the npm UI (package settings, Trusted Publisher, GitHub Actions,
   repository `AkaraChen/cpajs`, workflow `release.yml`, environment `npm`) or with `scripts/trust-publishers.ts` after adding `@cpajs/codex-auth` to its `packages` array.

## Wiring it into release.yml afterwards

- Add a pack step for `packages/codex-auth` (`npm pack --pack-destination <out>` after `pnpm --filter @cpajs/codex-auth build`).
  `scripts/pack.ts` only packs `packages/cpa` and `dist-npm/`, so it is unaffected until you extend it.
- In the publish job, publish the codex-auth tarball after `@cpajs/cpa` (its optional peer range `^0.1.0-rc` must already exist).
- Extend the tag check so the tag also matches `packages/codex-auth/package.json`, or keep both versions in lockstep.
