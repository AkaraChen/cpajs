export const ISSUER = 'https://auth.openai.com';
export const T0 = Date.UTC(2026, 9, 25, 0, 0, 0);

export function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** header.payload.signature with an obviously fake signature. */
export function jwt(claims: Record<string, unknown>): string {
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(claims))}.fake-signature`;
}

export function idToken(over: { email?: string | null; accountId?: string; plan?: string; extra?: Record<string, unknown> } = {}): string {
  const auth: Record<string, unknown> = {};
  if (over.accountId !== undefined) auth.chatgpt_account_id = over.accountId;
  else auth.chatgpt_account_id = 'acct-123';
  if (over.plan !== undefined) auth.chatgpt_plan_type = over.plan;
  return jwt({
    ...(over.email === null ? {} : { email: over.email ?? 'user@example.com' }),
    exp: 1_800_000_000,
    'https://api.openai.com/auth': auth,
    ...over.extra,
  });
}

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type Scripted = Response | Error | ((req: Recorded, init: RequestInit) => Response | Promise<Response>);

/** Scripted fake fetch: queue responses per URL; unexpected URLs or an empty queue throw. */
export function fakeFetch() {
  const queues = new Map<string, Scripted[]>();
  const calls: Recorded[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const rec: Recorded = { url, method: init.method ?? 'GET', headers, body: String(init.body ?? '') };
    calls.push(rec);
    const queue = queues.get(url);
    if (!queue?.length) throw new Error(`unexpected request to ${url}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(rec, init);
    return next.clone();
  }) as typeof fetch;
  return {
    fetch: fn,
    calls,
    /** Queue responses; the last one repeats forever. */
    on(url: string, ...responses: Scripted[]) {
      queues.set(url, [...(queues.get(url) ?? []), ...responses]);
    },
    callsTo(url: string) {
      return calls.filter((c) => c.url === url);
    },
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function text(body: string, status: number): Response {
  return new Response(body, { status });
}

export const URLS = {
  usercode: `${ISSUER}/api/accounts/deviceauth/usercode`,
  devicetoken: `${ISSUER}/api/accounts/deviceauth/token`,
  token: `${ISSUER}/oauth/token`,
};

export function tokenBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    id_token: idToken({ plan: 'plus' }),
    token_type: 'Bearer',
    expires_in: 3600,
    ...over,
  };
}
