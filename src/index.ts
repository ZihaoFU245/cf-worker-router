import { Hono } from 'hono';
import {
  base64urlDecode,
  base64urlDecodeToUint8Array,
  filterRequestHeaders,
  filterResponseHeaders,
  isHttpsAbsolute,
  appendCors,
  preflightResponse,
  parseSetCookieHeaders,
  urlEncodeXSetCookie,
  getOriginFor,
  applyBrowserHeaderDefaults,
  arrayBufferToBase64,
  headersToObject,
} from './utils';
import type { EnvWithDO } from './session_do';
import { getCookieHeaderFromDO, mergeSetCookiesToDO } from './session_do';

type Bindings = {
  CONNECTOR_ORIGIN: string;
} & Partial<EnvWithDO>;

const app = new Hono<{ Bindings: Bindings }>();
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_BATCH_REQUESTS = 16;
const textDecoder = new TextDecoder();

async function enrichHeadersForUpstream(
  headers: Headers,
  sid: string,
  target: string,
  env: Bindings,
): Promise<string | null> {
  if (!headers.has('user-agent')) headers.set('user-agent', DEFAULT_UA);
  applyBrowserHeaderDefaults(headers);
  const origin = getOriginFor(target);
  if (sid && origin && env.SESSION_DO) {
    const cookie = await getCookieHeaderFromDO(env as any, sid, origin);
    if (cookie) headers.set('cookie', cookie);
  }
  return origin;
}

async function persistSetCookies(
  env: Bindings,
  sid: string,
  origin: string | null,
  setCookies: string[],
) {
  if (!sid || !origin || !setCookies.length || !env.SESSION_DO) return;
  await mergeSetCookiesToDO(env as any, sid, origin, setCookies);
}

function withCors(h: Headers, origin: string | undefined) {
  appendCors(h, origin || '*');
}

app.options('/p', (c) => {
  return preflightResponse(c.env.CONNECTOR_ORIGIN || '*');
});

app.options('/fetch', (c) => {
  return preflightResponse(c.env.CONNECTOR_ORIGIN || '*');
});

app.options('/dispatch', (c) => {
  return preflightResponse(c.env.CONNECTOR_ORIGIN || '*');
});

async function handleP(c: any) {
  const allowOrigin = c.env.CONNECTOR_ORIGIN || '*';
  const sid = c.req.query('sid') || '';
  const uParam = c.req.query('u') || '';
  if (!uParam) {
    const h = new Headers({ 'Content-Type': 'text/plain' });
    withCors(h, allowOrigin);
    return new Response('Missing u', { status: 400, headers: h });
  }
  let target: string;
  try {
    target = base64urlDecode(uParam);
  } catch {
    const h = new Headers({ 'Content-Type': 'text/plain' });
    withCors(h, allowOrigin);
    return new Response('Bad u', { status: 400, headers: h });
  }
  if (!isHttpsAbsolute(target)) {
    const h = new Headers({ 'Content-Type': 'text/plain' });
    withCors(h, allowOrigin);
    return new Response('Only https targets allowed', { status: 400, headers: h });
  }

  const upstreamHeaders = filterRequestHeaders(new Headers(c.req.raw.headers));
  // Pass through Range if present
  const range = c.req.header('range');
  if (range) upstreamHeaders.set('range', range);
  const origin = await enrichHeadersForUpstream(upstreamHeaders, sid, target, c.env);

  const method = c.req.method === 'HEAD' ? 'HEAD' : 'GET';
  const upstreamReqInit: RequestInit = {
    method,
    headers: upstreamHeaders,
    redirect: 'follow',
  };

  const resp = await fetch(target, upstreamReqInit);

  // Merge Set-Cookie into DO and emit X-Set-Cookie
  const setCookies = parseSetCookieHeaders(resp.headers);
  const outHeaders = filterResponseHeaders(resp.headers);
  await persistSetCookies(c.env, sid, origin, setCookies);
  const xsc = urlEncodeXSetCookie(setCookies);
  if (xsc) outHeaders.set('X-Set-Cookie', xsc);
  withCors(outHeaders, allowOrigin);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: outHeaders });
}

app.get('/p', handleP);
// Hono type may not expose .head(); use .on for HEAD
app.on('HEAD', '/p', handleP as any);

app.post('/fetch', async (c) => {
  const allowOrigin = c.env.CONNECTOR_ORIGIN || '*';
  type FetchBody = {
    sid?: string;
    target?: string;
    method?: string;
    headers?: Record<string, string>;
    bodyB64?: string;
  };
  let body: FetchBody;
  try {
    body = await c.req.json<FetchBody>();
  } catch {
    const h = new Headers({ 'Content-Type': 'text/plain' });
    withCors(h, allowOrigin);
    return new Response('Invalid JSON', { status: 400, headers: h });
  }
  const { sid = '', target = '', method = 'GET', headers = {}, bodyB64 } = body;
  if (!isHttpsAbsolute(target)) {
    const h = new Headers({ 'Content-Type': 'text/plain' });
    withCors(h, allowOrigin);
    return new Response('Only https targets allowed', { status: 400, headers: h });
  }
  const m = method.toUpperCase();
  if (!['GET', 'HEAD', 'POST'].includes(m)) {
    const h = new Headers({ 'Content-Type': 'text/plain' });
    withCors(h, allowOrigin);
    return new Response('Method not allowed', { status: 405, headers: h });
  }

  const upstreamHeaders = filterRequestHeaders(new Headers(headers as Record<string, string>));
  const origin = await enrichHeadersForUpstream(upstreamHeaders, sid, target, c.env);

  let bodyInit: BodyInit | undefined = undefined;
  if (bodyB64) {
    const bytes = base64urlDecodeToUint8Array(bodyB64);
    bodyInit = bytes;
  }

  const upstreamReq: RequestInit = {
    method: m,
    headers: upstreamHeaders,
    body: m === 'GET' || m === 'HEAD' ? undefined : bodyInit,
    redirect: 'follow',
  };

  const resp = await fetch(target, upstreamReq);
  const setCookies = parseSetCookieHeaders(resp.headers);
  const outHeaders = filterResponseHeaders(resp.headers);
  await persistSetCookies(c.env, sid, origin, setCookies);
  const xsc = urlEncodeXSetCookie(setCookies);
  if (xsc) outHeaders.set('X-Set-Cookie', xsc);
  withCors(outHeaders, allowOrigin);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: outHeaders });
});

app.post('/dispatch', async (c) => {
  const allowOrigin = c.env.CONNECTOR_ORIGIN || '*';
  type DispatchUnit = {
    id?: string;
    target?: string;
    method?: string;
    headers?: Record<string, string>;
    bodyB64?: string;
    responseType?: 'arrayBuffer' | 'text' | 'json' | 'none';
  };
  type DispatchBody = {
    sid?: string;
    requests?: DispatchUnit[];
    pipeline?: 'sequential' | 'parallel';
  };

  let body: DispatchBody;
  try {
    body = await c.req.json<DispatchBody>();
  } catch {
    const h = new Headers({ 'Content-Type': 'application/json' });
    withCors(h, allowOrigin);
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: h });
  }

  const sid = body.sid || '';
  const requests = Array.isArray(body.requests) ? body.requests : [];
  if (!requests.length) {
    const h = new Headers({ 'Content-Type': 'application/json' });
    withCors(h, allowOrigin);
    return new Response(JSON.stringify({ error: 'requests array required' }), { status: 400, headers: h });
  }
  if (requests.length > MAX_BATCH_REQUESTS) {
    const h = new Headers({ 'Content-Type': 'application/json' });
    withCors(h, allowOrigin);
    return new Response(JSON.stringify({ error: `Too many requests (max ${MAX_BATCH_REQUESTS})` }), {
      status: 400,
      headers: h,
    });
  }

  const runSequentially = body.pipeline !== 'parallel';
  const aggregateXSetCookies: string[] = [];

  const execUnit = async (unit: DispatchUnit, index: number) => {
    const id = unit.id || `req-${index}`;
    const target = unit.target || '';
    if (!isHttpsAbsolute(target)) {
      return {
        id,
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        error: 'Only https targets allowed',
      };
    }
    const method = (unit.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST'].includes(method)) {
      return {
        id,
        ok: false,
        status: 405,
        statusText: 'Method Not Allowed',
        headers: {},
        error: `Unsupported method ${method}`,
      };
    }
    const upstreamHeaders = filterRequestHeaders(new Headers(unit.headers || {}));
    const origin = await enrichHeadersForUpstream(upstreamHeaders, sid, target, c.env);

    let bodyInit: BodyInit | undefined = undefined;
    if (unit.bodyB64) {
      try {
        const bytes = base64urlDecodeToUint8Array(unit.bodyB64);
        if (method !== 'GET' && method !== 'HEAD') {
          bodyInit = bytes;
        }
      } catch {
        return {
          id,
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          headers: {},
          error: 'Invalid bodyB64 payload',
        };
      }
    }

    const started = Date.now();
    let resp: Response;
    try {
      resp = await fetch(target, {
        method,
        headers: upstreamHeaders,
        body: method === 'GET' || method === 'HEAD' ? undefined : bodyInit,
        redirect: 'follow',
      });
    } catch (err) {
      return {
        id,
        ok: false,
        status: 0,
        statusText: 'FETCH_ERROR',
        headers: {},
        error: err instanceof Error ? err.message : 'Unknown fetch error',
      };
    }
    const latency = Date.now() - started;

    const setCookies = parseSetCookieHeaders(resp.headers);
    await persistSetCookies(c.env, sid, origin, setCookies);
    const outHeaders = filterResponseHeaders(resp.headers);
    const xsc = urlEncodeXSetCookie(setCookies);
    if (xsc) {
      outHeaders.set('X-Set-Cookie', xsc);
      aggregateXSetCookies.push(xsc);
    }

    let bodyPayload: { encoding: string; data: unknown; note?: string } | undefined;
    const responseType = unit.responseType || 'arrayBuffer';
    if (method !== 'HEAD' && responseType !== 'none') {
      const buffer = await resp.arrayBuffer();
      if (responseType === 'arrayBuffer') {
        bodyPayload = { encoding: 'base64', data: arrayBufferToBase64(buffer) };
      } else {
        const text = textDecoder.decode(new Uint8Array(buffer));
        if (responseType === 'text') {
          bodyPayload = { encoding: 'text', data: text };
        } else if (responseType === 'json') {
          try {
            bodyPayload = { encoding: 'json', data: JSON.parse(text) };
          } catch {
            bodyPayload = {
              encoding: 'text',
              data: text,
              note: 'Failed to parse JSON; returned raw text.',
            };
          }
        }
      }
    }

    return {
      id,
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      headers: headersToObject(outHeaders),
      finalUrl: resp.url,
      redirected: resp.redirected,
      durationMs: latency,
      body: bodyPayload,
    };
  };

  const results: Array<Awaited<ReturnType<typeof execUnit>>> = [];
  if (runSequentially) {
    for (let i = 0; i < requests.length; i++) {
      const unit = requests[i];
      // sequential to preserve cookie ordering
      // eslint-disable-next-line no-await-in-loop -- Sequential execution required for cookie ordering
      results.push(await execUnit(unit, i));
    }
  } else {
    const parallel = await Promise.all(requests.map((unit, index) => execUnit(unit, index)));
    results.push(...parallel);
  }

  const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
  if (aggregateXSetCookies.length) {
    aggregateXSetCookies.forEach((cookie) => responseHeaders.append('X-Set-Cookie', cookie));
  }
  withCors(responseHeaders, allowOrigin);
  const payload = {
    sid,
    pipeline: runSequentially ? 'sequential' : 'parallel',
    count: results.length,
    results,
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: responseHeaders,
  });
});

export default app;
export { SessionDO } from './session_do';
