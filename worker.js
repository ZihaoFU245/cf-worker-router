// Worker entrypoint (Modules syntax)
export default {
  async fetch(request, env, ctx) {
    const ALLOW_ORIGIN = '*'; // For quick testing. Replace with your GitHub Pages origin for stricter CORS.

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': ALLOW_ORIGIN,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/magic') {
      return new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOW_ORIGIN,
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ ok: false, error: 'Use POST' }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOW_ORIGIN,
        },
      });
    }

    // Expect JSON: { key: "..." }
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOW_ORIGIN,
        },
      });
    }

    const provided = String(body?.key ?? '');
    const expected = String(env.KEY ?? '');

    if (!expected) {
      return new Response(
        JSON.stringify({ ok: false, error: 'KEY not configured on server' }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': ALLOW_ORIGIN,
          },
        },
      );
    }

    if (provided !== expected) {
      return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOW_ORIGIN,
        },
      });
    }

    const magic = String(env.MAGIC_WORD ?? 'swordfish');
    return new Response(JSON.stringify({ ok: true, magic }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // CORS
        'Access-Control-Allow-Origin': ALLOW_ORIGIN,
        Vary: 'Origin',
        // Cache off for demo
        'Cache-Control': 'no-store',
      },
    });
  },
};

