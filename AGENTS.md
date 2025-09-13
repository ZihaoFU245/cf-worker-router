# Goal

A tiny end‑to‑end demo:

1. A Cloudflare Worker validates a **key** and, if correct, returns a **magic word**.
2. A GitHub Pages site (static HTML+JS) asks for **Worker URL** and **Key**, sends a request, and displays the returned magic word.

Everything here is copy‑paste runnable—no build tools.

---

## 1) Cloudflare Worker (Modules syntax)

**File:** `worker.js` (or paste into CF Dashboard → Workers → Create → Quick edit)

> Set a secret named `KEY` with your shared key (Dashboard → Settings → Variables → Secrets → `KEY`) and an environment variable (optional) named `MAGIC_WORD` (defaults to `swordfish`).

```js
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
      return new Response(JSON.stringify({ ok: false, error: 'KEY not configured on server' }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOW_ORIGIN,
        },
      });
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
        'Vary': 'Origin',
        // Cache off for demo
        'Cache-Control': 'no-store',
      },
    });
  },
};
```

**Configure Secrets:**

* Dashboard → *Settings → Variables → Secrets* → **Add** `KEY` → put your chosen test key.
* (Optional) Add plain-text Env Var `MAGIC_WORD` → your chosen word.

**Endpoint:** `POST https://<your-worker-subdomain>.<your-account>.<region>.workers.dev/magic`

Payload:

```json
{ "key": "YOUR_KEY" }
```

**Quick cURL test:**

```bash
curl -i \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"key":"YOUR_KEY"}' \
  https://<your-worker>.workers.dev/magic
```

---

## 2) GitHub Pages connector (one static file)

**File:** `index.html` (place in your `gh-pages` branch or your Pages root)

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CF Worker Connectivity Test</title>
  <style>
    :root { font: 16px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial; }
    body { margin: 0; background: #0f172a; color: #e5e7eb; display: grid; place-items: center; min-height: 100vh; }
    .card { width: min(680px, 92vw); background: #111827; border: 1px solid #374151; border-radius: 16px; padding: 20px 20px 16px; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
    h1 { font-size: 1.25rem; margin: 0 0 12px; }
    p.hint { margin-top: 0; color: #9ca3af; }
    label { display: block; margin: 14px 0 6px; color: #cbd5e1; }
    input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid #334155; background: #0b1220; color: #e5e7eb; }
    .row { display: flex; gap: 8px; margin-top: 14px; }
    button { cursor: pointer; padding: 10px 14px; border-radius: 10px; border: 1px solid #22c55e; background: #16a34a; color: #052e16; font-weight: 700; }
    button:disabled { opacity: .6; cursor: not-allowed; }
    .out { margin-top: 16px; padding: 12px; border-radius: 10px; background: #0b1220; border: 1px dashed #475569; min-height: 2.5rem; white-space: pre-wrap; word-break: break-word; }
    .ok { color: #34d399; }
    .err { color: #fca5a5; }
    small { color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Cloudflare Worker Connectivity Test</h1>
    <p class="hint">Enter your Worker URL and shared key. We’ll POST to <code>/magic</code> and display the response.</p>

    <label for="url">Worker URL (include <code>/magic</code>)</label>
    <input id="url" placeholder="https://<your-worker>.workers.dev/magic" />

    <label for="key">Key</label>
    <input id="key" type="password" placeholder="YOUR_KEY" />

    <div class="row">
      <button id="go">Send</button>
      <button id="ping" title="Sends a JSON POST with your key and shows the result.">Ping</button>
    </div>

    <div class="out" id="out"></div>
    <small>Tip: For production, lock CORS to your Pages origin instead of <code>*</code>.</small>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);

    async function call() {
      const url = $('url').value.trim();
      const key = $('key').value;
      const out = $('out');

      if (!url) { out.textContent = 'Please enter the full Worker endpoint URL (ending with /magic).'; return; }
      if (!key) { out.textContent = 'Please enter a key.'; return; }

      $('go').disabled = true; $('ping').disabled = true; out.textContent = 'Sending…';
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { data = { ok:false, error:'Non-JSON response', raw:text }; }

        if (res.ok && data?.ok) {
          out.innerHTML = `<span class="ok">✅ Success!</span> Magic word: <strong>${String(data.magic)}</strong>`;
        } else {
          out.innerHTML = `<span class="err">❌ Error ${res.status}</span> ${data?.error ?? text}`;
        }
      } catch (e) {
        out.innerHTML = `<span class="err">❌ Network error</span> ${e?.message ?? e}`;
      } finally {
        $('go').disabled = false; $('ping').disabled = false;
      }
    }

    $('go').addEventListener('click', call);
    $('ping').addEventListener('click', call);

    // Optional: persist last used URL in localStorage
    (function init() {
      const last = localStorage.getItem('cf_magic_url');
      if (last) $('url').value = last;
      $('url').addEventListener('change', () => localStorage.setItem('cf_magic_url', $('url').value.trim()));
    })();
  </script>
</body>
</html>
```

> If your worker URL is `https://demo-worker.yourname.workers.dev`, the input should be `https://demo-worker.yourname.workers.dev/magic`.

---

## 3) Deploy steps (quick)

1. **Create Worker**: CF Dashboard → Workers & Pages → Create Worker → *Quick edit* → paste **worker.js** → **Deploy**.
2. **Set secrets**: *Settings → Variables → Secrets* → add `KEY`. (Optional env var `MAGIC_WORD`.)
3. **Open your Pages site** (e.g., `https://<username>.github.io/connect-test/`) and paste the Worker endpoint and key.

---

## 4) Notes & Hardening (after it works)

* **CORS**: Replace `'*'` with your exact origin (e.g., `https://<username>.github.io`). Add `Access-Control-Allow-Credentials` only if using cookies (not needed here).
* **Rate limiting**: Add a simple bucket using Durable Objects or KV-backed counters if you expose publicly.
* **HTTPS only**: Both sides already use HTTPS; avoid mixed content by always using `https://` in the Worker URL field.
* **No secrets in client**: The *shared key* is typed by you each time; don’t bake it into the page.

---

## 5) Troubleshooting quicklist

* **CORS error in console**: Make sure the Worker sends `Access-Control-Allow-Origin` and honors `OPTIONS` preflight.
* **401 Unauthorized**: Verify the value of `KEY` secret in Worker matches what you type on the page.
* **404**: Ensure your input URL ends with `/magic` (as coded above).
* **JSON error**: The page sends JSON. Confirm `Content-Type: application/json` handling in the Worker.

---

## 6) (Optional) Wrangler local/dev

If you prefer wrangler:

```toml
# wrangler.toml
name = "magic-test"
main = "worker.js"
compatibility_date = "2024-09-01"
```

```bash
wrangler secret put KEY
wrangler publish
```

That's it—paste your endpoint + key into the GitHub Pages tester and you should see the magic word.
