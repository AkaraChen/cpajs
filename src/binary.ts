/**
 * Entry point for bundlers: importing `@cpajs/cpa/binary` (for its side effect)
 * puts the installed platform packages in the module graph, so a tracer such as
 * @vercel/nft copies the one that matches the deployment.
 *
 * The table itself is generated into binary-packages.cjs; see
 * scripts/generate-binary-table.ts and src/server/binary.ts.
 */
export { PLATFORM_PACKAGES, resolvePlatformPackage } from './binary-packages.cjs';
export type { PlatformTargetId } from './binary-packages.cjs';
