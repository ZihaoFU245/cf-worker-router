import { Hono } from 'hono';
import { base64urlDecode, filterRequestHeaders, filterResponseHeaders, isHttpsAbsolute, appendCors, preflightResponse, parseSetCookieHeaders, urlEncodeXSetCookie, getOriginFor } from './utils';
import type { EnvWithDO } from './session_do';
import { getCookieHeaderFromDO, mergeSetCookiesToDO } from './session_do';

type Bindings = {
  CONNECTOR_ORIGIN: string;
} & Partial<EnvWithDO>;

const app = new Hono<{ Bindings: Bindings }>();
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function withCors(h: Headers, origin: string | undefined) {
  appendCors(h, origin || '*');
}

app.options('/p', (c) => {
  return preflightResponse(c.env.CONNECTOR_ORIGIN || '*');
});

app.options('/fetch', (c) => {
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
  // Ensure UA present (some origins 405/412 without a browser-like UA)
  if (!upstreamHeaders.has('user-agent')) upstreamHeaders.set('user-agent', DEFAULT_UA);

  // If DO is present and sid + origin available, attach cookie
  const origin = getOriginFor(target);
  if (sid && origin && c.env.SESSION_DO) {
    const cookie = await getCookieHeaderFromDO(c.env as any, sid, origin);
    if (cookie) upstreamHeaders.set('cookie', cookie);
  }

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
  if (sid && origin && setCookies.length && c.env.SESSION_DO) {
    await mergeSetCookiesToDO(c.env as any, sid, origin, setCookies);
  }
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
  // Respect provided UA if any; otherwise set a default Chrome UA
  if (!upstreamHeaders.has('user-agent')) upstreamHeaders.set('user-agent', DEFAULT_UA);
  const origin = getOriginFor(target);
  if (sid && origin && c.env.SESSION_DO) {
    const cookie = await getCookieHeaderFromDO(c.env as any, sid, origin);
    if (cookie) upstreamHeaders.set('cookie', cookie);
  }

  let bodyInit: BodyInit | undefined = undefined;
  if (bodyB64) {
    const raw = base64urlDecode(bodyB64);
    // Convert string to Uint8Array for binary safety
    const bytes = new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
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
  if (sid && origin && setCookies.length && c.env.SESSION_DO) {
    await mergeSetCookiesToDO(c.env as any, sid, origin, setCookies);
  }
  const xsc = urlEncodeXSetCookie(setCookies);
  if (xsc) outHeaders.set('X-Set-Cookie', xsc);
  withCors(outHeaders, allowOrigin);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: outHeaders });
});

export default app;
export { SessionDO } from './session_do';
