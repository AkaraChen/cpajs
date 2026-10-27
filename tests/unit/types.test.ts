// Compile-time checks for the lifecycle option types. The functions are never
// called: startServer would need a real binary, and only the contextual types
// of the options and callbacks matter here.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CpaClient } from '../../src/client/index.ts';
import {
  startServer,
  type CpaServer,
  type ExitReason,
  type ServerHooks,
} from '../../src/server/index.ts';

describe('lifecycle types', () => {
  it('narrows the afterStart client to CpaClient when cpajs knows the key', () => {
    const managed = () =>
      startServer({
        hooks: {
          afterStart: (ctx) => {
            expectTypeOf(ctx.client).toEqualTypeOf<CpaClient>();
            expectTypeOf(ctx.requireClient()).toEqualTypeOf<CpaClient>();
          },
        },
      });
    const explicit = () =>
      startServer({
        management: { key: 'known-key' },
        hooks: {
          afterStart: (ctx) => {
            expectTypeOf(ctx.client).toEqualTypeOf<CpaClient>();
          },
        },
      });

    expect(managed).toBeTypeOf('function');
    expect(explicit).toBeTypeOf('function');
  });

  it('keeps the client optional when the key may be unknown', () => {
    const disabled = () =>
      startServer({
        management: false,
        hooks: {
          afterStart: (ctx) => {
            expectTypeOf(ctx.client).toEqualTypeOf<undefined>();
          },
        },
      });
    const configPath = () =>
      startServer({
        configPath: '/tmp/cpa-config.yaml',
        hooks: {
          afterStart: (ctx) => {
            expectTypeOf(ctx.client).toEqualTypeOf<CpaClient | undefined>();
          },
        },
      });
    const ownSecret = () =>
      startServer({
        config: { management: { 'secret-key': 'file-secret' } },
        hooks: {
          afterStart: (ctx) => {
            expectTypeOf(ctx.client).toEqualTypeOf<CpaClient | undefined>();
          },
        },
      });

    expect(disabled).toBeTypeOf('function');
    expect(configPath).toBeTypeOf('function');
    expect(ownSecret).toBeTypeOf('function');
  });

  it('accepts a cleanup function synchronously or through a promise', () => {
    const sync = () => startServer({ hooks: { afterStart: () => () => undefined } });
    const async = () =>
      startServer({
        hooks: {
          afterStart: async (ctx) => {
            const client: CpaClient = ctx.requireClient();
            void client;
            return async () => undefined;
          },
        },
      });
    const typed: ServerHooks<CpaClient> = { afterStart: () => Promise.resolve(() => undefined) };

    expect(sync).toBeTypeOf('function');
    expect(async).toBeTypeOf('function');
    expect(typed).toBeTypeOf('object');
  });

  it('types the on option per event', () => {
    const subscribe = () =>
      startServer({
        on: {
          exit: (event) => {
            expectTypeOf(event.reason).toEqualTypeOf<ExitReason>();
            expectTypeOf(event.willRestart).toEqualTypeOf<boolean>();
          },
          restarted: (event) => {
            expectTypeOf(event.attempt).toEqualTypeOf<number>();
          },
        },
      });

    expect(subscribe).toBeTypeOf('function');
  });

  it('keeps the startServer contract', () => {
    expectTypeOf(startServer).returns.toEqualTypeOf<Promise<CpaServer>>();
  });
});
