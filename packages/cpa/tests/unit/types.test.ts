// Compile-time checks for the lifecycle option types. The functions are never
// called: startServer would need a real binary, and only the contextual types
// of the options and callbacks matter here.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  startServer,
  type ConfigContext,
  type ConfigReason,
  type CpaConfig,
  type CpaServer,
} from '../../src/server/index.ts';

describe('lifecycle types', () => {
  it('types a config function context and return value', () => {
    const config = () =>
      startServer({
        config: (ctx: ConfigContext) => {
          expectTypeOf(ctx.reason).toEqualTypeOf<ConfigReason>();
          expectTypeOf(ctx.existing).toEqualTypeOf<CpaConfig | undefined>();
          return { routing: { strategy: 'fill-first' } };
        },
      });
    const asyncConfig = () =>
      startServer({
        config: async () => Promise.resolve({ routing: { strategy: 'round-robin' } }),
      });

    expect(config).toBeTypeOf('function');
    expect(asyncConfig).toBeTypeOf('function');
  });

  it('keeps the general startServer contract', () => {
    const server = () => startServer({ management: false });
    // @ts-expect-error config and configPath are mutually exclusive
    const invalid = () => startServer({ config: {}, configPath: '/tmp/cpa-config.yaml' });

    expectTypeOf(server).returns.toEqualTypeOf<Promise<CpaServer>>();
    expect(invalid).toBeTypeOf('function');
  });
});
