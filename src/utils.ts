export const base64urlDecode = (input: string): string => {
  // Convert base64url -> base64
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  // Pad as needed
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const decoded = atob(b64 + pad);
  return decoded;
};

export const isHttpsAbsolute = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
};

export const hopByHopHeaders = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'trailer',
  'te',
]);

export const disallowedRequestHeaders = new Set([
  'host',
  'cookie',
  'authorization',
  'content-length',
]);

export const safeResponseHeaders = [
  'content-type',
  'content-length',
  'accept-ranges',
  'content-range',
  'etag',
  'last-modified',
];

export function filterRequestHeaders(input: Headers): Headers {
  const out = new Headers();
  input.forEach((value, key) => {
    const k = key.toLowerCase();
    if (hopByHopHeaders.has(k)) return;
    if (disallowedRequestHeaders.has(k)) return;
    out.set(key, value);
  });
  return out;
}

export function filterResponseHeaders(input: Headers): Headers {
  const out = new Headers();
  safeResponseHeaders.forEach((k) => {
    const v = input.get(k);
    if (v !== null) out.set(k, v);
  });
  return out;
}

export function appendCors(headers: Headers, allowOrigin: string) {
  headers.set('Access-Control-Allow-Origin', allowOrigin || '*');
  headers.set(
    'Access-Control-Expose-Headers',
    'Content-Type, Content-Length, Accept-Ranges, Content-Range, ETag, Last-Modified, X-Set-Cookie',
  );
}

export function preflightResponse(allowOrigin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allowOrigin || '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export function getOriginFor(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    return u.origin;
  } catch {
    return null;
  }
}

export function parseSetCookieHeaders(headers: Headers): string[] {
  // Cloudflare Workers supports getAll, but TS lib may not have types; use as any
  const anyHeaders: any = headers as any;
  if (typeof anyHeaders.getAll === 'function') {
    return anyHeaders.getAll('set-cookie') ?? [];
  }
  const sc = headers.get('set-cookie');
  return sc ? [sc] : [];
}

export function urlEncodeXSetCookie(values: string[]): string | null {
  if (!values.length) return null;
  // Encode multiple Set-Cookie headers into a single URL-encoded string
  // We join by '\n' after encodeURIComponent for simplicity
  const encoded = values.map((v) => encodeURIComponent(v)).join(',');
  return encoded;
}

