export const base64urlDecode = (input: string): string => {
  // Convert base64url -> base64
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  // Pad as needed
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const decoded = atob(b64 + pad);
  return decoded;
};

export const base64urlDecodeToUint8Array = (input: string): Uint8Array => {
  const decoded = base64urlDecode(input);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
};

export const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
  'x-set-cookie',
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

export const BROWSER_HEADER_DEFAULTS: Record<string, string> = {
  'accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'en-US,en;q=0.9',
};

export function applyBrowserHeaderDefaults(headers: Headers) {
  for (const [key, value] of Object.entries(BROWSER_HEADER_DEFAULTS)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
}

export function headersToObject(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
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

