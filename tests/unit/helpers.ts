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
