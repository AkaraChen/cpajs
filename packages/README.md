# Platform packages

The `@cpajs/<target>` packages are generated, not checked in. Their manifests come from
[`src/server/targets.ts`](../src/server/targets.ts), which is the single list of targets
used by the runtime lookup, the build scripts and the CI matrix.

```sh
node scripts/build-binary.ts --target <id>     # → dist-bin/<id>/
node scripts/assemble-packages.ts              # → dist-npm/<id>/{package.json,bin/,BUILD-INFO.json,LICENSE,README.md}
                                               #   bin/ holds cli-proxy-api and, except on Windows, cpa-launcher
node scripts/pack.ts                           # → dist-npm/tarballs/*.tgz (main package gets optionalDependencies)
```

Each manifest sets `os`, `cpu` and, for the glibc/musl pairs, `libc`, plus `preferUnplugged: true`.
Its version always equals the main package version. `BUILD-INFO.json` records the CPA version, source
commit, Go toolchain and environment, build flags, plugin support, verification level, and the SHA-256 of
`cli-proxy-api` and `cpa-launcher`.
