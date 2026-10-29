# Releasing

Every published workspace package (`WORKSPACE_PACKAGES` in [`scripts/lib.ts`](../scripts/lib.ts): `@cpajs/cpa` and
`@cpajs/codex-auth`) and every `@cpajs/<target>` platform package is released together, at one version.

## A release

1. Bump every package in a release PR: `node scripts/versions.ts --set 0.1.0-rc.8`, then date each package's
   CHANGELOG section. CI runs `node scripts/versions.ts` and fails if the packages drift apart.
2. Merge the PR, then tag the merge commit `v<version>` and push the tag.
3. `release.yml` checks that every package is at the tag's version, builds the binaries, packs everything with
   `scripts/pack.ts`, runs the install tests, and publishes through npm trusted publishing (OIDC, with
   provenance) in this order: platform packages, a wait until all of them resolve on the registry
   (`scripts/wait-for-packages.ts`), `@cpajs/cpa`, then the other workspace packages. A prerelease version
   publishes to the dist-tag named by its prerelease id (`0.1.0-rc.8` → `rc`); a plain version to `latest`.

## Adding a package to the release

npm trusted publishing can only be configured for a package that already exists, so a new package is published
once by hand before the workflow can publish it.

1. Create `packages/<name>/` at the shared version and add it to `WORKSPACE_PACKAGES` only after step 4.
2. Publish a bootstrap version **below** the current one, so the next release publishes the shared version
   normally. From the package directory: `npm pkg set version=<lower version>`, `npm pack`, revert the
   version, then `npm publish <tarball> --access public --tag rc` with your own account (2FA).
3. npm puts the first publish of a new package into **staged publishing**: the registry shows a
   `0.0.0-stage` placeholder until you approve it. Run `npm stage list <name>`, check it with
   `npm stage view <stage-id>`, then `npm stage approve <stage-id>`.
4. Add the package to `WORKSPACE_PACKAGES` and run `node scripts/trust-publishers.ts` (browser login with 2FA). It
   configures trust for every package that lacks it and skips the rest.

`@cpajs/codex-auth` was bootstrapped this way at `0.1.0-rc.6`; its first release through the workflow is the
next shared version.
