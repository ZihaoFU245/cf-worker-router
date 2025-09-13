export type SessionState = {
  // Map origin -> cookieMap(name -> value)
  cookies: Record<string, Record<string, string>>;
  lastUsed: number;
};

function parseCookiePair(str: string): [string, string] | null {
  const eq = str.indexOf('=');
  if (eq === -1) return null;
  const name = str.slice(0, eq).trim();
  const value = str.slice(eq + 1).trim();
  if (!name) return null;
  return [name, value];
}

function parseSetCookie(sc: string): { name: string; value: string; attrs: Record<string, string> } | null {
  const parts = sc.split(';');
  const nv = parts.shift();
  if (!nv) return null;
  const nvPair = parseCookiePair(nv);
  if (!nvPair) return null;
  const attrs: Record<string, string> = {};
  for (const p of parts) {
    const [k, v] = p.split('=');
    const key = (k || '').trim().toLowerCase();
    const val = (v || '').trim();
    if (key) attrs[key] = val;
  }
  return { name: nvPair[0], value: nvPair[1], attrs };
}

export class SessionDO implements DurableObject {
  state: DurableObjectState;
  storage: DurableObjectStorage;
  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
    this.storage = state.storage;
  }

  private async load(): Promise<SessionState> {
    const data = (await this.storage.get<SessionState>('state')) || {
      cookies: {},
      lastUsed: Date.now(),
    };
    return data;
  }

  private async save(s: SessionState) {
    s.lastUsed = Date.now();
    await this.storage.put('state', s);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/getCookieHeader') {
      const originParam = url.searchParams.get('origin');
      if (!originParam) return new Response('', { status: 400 });
      const st = await this.load();
      const jar = st.cookies[originParam] || {};
      const cookieHeader = Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      return new Response(cookieHeader, { status: 200 });
    }
    if (url.pathname === '/mergeSetCookies' && request.method === 'POST') {
      const originParam = url.searchParams.get('origin');
      if (!originParam) return new Response('', { status: 400 });
      const list: string[] = await request.json();
      const st = await this.load();
      const jar = (st.cookies[originParam] = st.cookies[originParam] || {});
      for (const sc of list) {
        const parsed = parseSetCookie(sc);
        if (!parsed) continue;
        // naive domain/path handling: keep by origin only
        jar[parsed.name] = parsed.value;
      }
      await this.save(st);
      return new Response('ok', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }
}

export type EnvWithDO = {
  SESSION_DO: DurableObjectNamespace;
};

export async function getCookieHeaderFromDO(env: EnvWithDO, sid: string, origin: string): Promise<string | null> {
  try {
    const id = env.SESSION_DO.idFromName(sid);
    const stub = env.SESSION_DO.get(id);
    const resp = await stub.fetch(`https://do/getCookieHeader?origin=${encodeURIComponent(origin)}`);
    if (!resp.ok) return null;
    const text = await resp.text();
    return text || null;
  } catch {
    return null;
  }
}

export async function mergeSetCookiesToDO(env: EnvWithDO, sid: string, origin: string, setCookies: string[]) {
  try {
    const id = env.SESSION_DO.idFromName(sid);
    const stub = env.SESSION_DO.get(id);
    await stub.fetch(`https://do/mergeSetCookies?origin=${encodeURIComponent(origin)}`, {
      method: 'POST',
      body: JSON.stringify(setCookies),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    // ignore
  }
}
