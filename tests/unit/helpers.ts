import { createClient } from '../../src/client/index.ts';

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  contentType: string | null;
  formData?: FormData;
}

/** A client whose fetch records requests and answers with `respond`. */
export function mockClient(
  respond: (req: Recorded) => Response | Promise<Response> = () => Response.json({ status: 'ok' }),
  options: { baseUrl?: string; timeoutMs?: number; headers?: HeadersInit } = {},
) {
  const calls: Recorded[] = [];
  const client = createClient({
    baseUrl: options.baseUrl ?? 'http://cpa.test:8317',
    managementKey: 'mgmt-key',
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    fetch: async (request) => {
      const contentType = request.headers.get('content-type');
      const recorded: Recorded = {
        method: request.method,
        url: new URL(request.url),
        headers: request.headers,
        contentType,
        body: '',
      };
      if (contentType?.startsWith('multipart/form-data')) recorded.formData = await request.formData();
      else recorded.body = await request.text();
      calls.push(recorded);
      return respond(recorded);
    },
  });
  return { client, calls };
}

/** An AbortController whose signal counts live 'abort' listeners. */
export function countingController(): { controller: AbortController; listeners: () => number } {
  const controller = new AbortController();
  const signal = controller.signal;
  const live = new Set<unknown>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
    if (type !== 'abort') return add(type, listener as EventListener, options as AddEventListenerOptions);
    live.add(listener);
    // A `once` listener is dropped by the event system when it fires, without a
    // removeEventListener call; mirror that so the count stays truthful.
    const once = typeof options === 'object' && options !== null && (options as AddEventListenerOptions).once === true;
    if (once) add('abort', () => live.delete(listener), { once: true });
    add(type, listener as EventListener, options as AddEventListenerOptions);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
    if (type === 'abort') live.delete(listener);
    remove(type, listener as EventListener, options as EventListenerOptions);
  }) as typeof signal.removeEventListener;
  return { controller, listeners: () => live.size };
}
