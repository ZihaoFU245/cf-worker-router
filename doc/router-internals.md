# Router Worker Internals

Welcome aboard! This document walks through how the Cloudflare Worker in this
repository is structured, why certain decisions were made, and what to watch out
for when extending it. Treat it as the starting point for debugging or feature
work.

## High-level Responsibilities

1. **Act like a browser.** Every outbound request should resemble a modern
   Chrome user agent so that origin servers return the same content they would to
   a real browser.
2. **Keep sessions isolated.** We rely on Durable Objects to persist cookies per
   connector `sid` so that concurrent sandboxes do not interfere with each other.
3. **Move bytes efficiently.** `/p` and `/fetch` stream upstream bodies directly
   back to the caller. `/dispatch` materialises bodies only when explicitly
   requested to allow batching.
4. **Stay safe.** We only accept `https` targets and strip hop-by-hop or
   sensitive headers to avoid request smuggling or cache poisoning.

## Project Layout

```
src/
  index.ts        // Hono router + business logic
  session_do.ts   // Durable Object implementation for cookies
  utils.ts        // Shared helpers (base64, header filters, etc.)
wrangler.toml     // Worker configuration / bindings
```

### Entry point: `src/index.ts`

The file wires up three main routes:

* `GET|HEAD /p` – Streaming passthrough for media/asset fetches.
* `POST /fetch` – Streaming control-plane request (one upstream fetch).
* `POST /dispatch` – Batched control-plane request that materialises bodies to
  JSON payloads.

All routes share helper functions:

* `enrichHeadersForUpstream` – Applies browser defaults and injects cookies from
  Durable Objects when available.
* `persistSetCookies` – Writes `Set-Cookie` headers back into the session DO.
* `filterRequestHeaders` / `filterResponseHeaders` – Enforce allowed header
  lists.

`/dispatch` is intentionally sequential by default to preserve cookie ordering.
Callers can opt-in to `pipeline: "parallel"`, but note that cookies are still
shared through the DO which means the last writer wins.

### Default Browser Fingerprint

To mimic a regular agent we set the following defaults when the connector does
not supply them:

* `User-Agent` – Chrome 124 on Windows 10 (update periodically).
* `Accept` – Includes HTML, XML, AVIF, WebP, generic bytes.
* `Accept-Language` – `en-US,en;q=0.9`.

You can tweak these in `utils.ts` via `BROWSER_HEADER_DEFAULTS`.

### Batch Execution (`POST /dispatch`)

Batch units (`DispatchUnit`) accept:

* `target` – absolute `https` URL.
* `method` – `GET`/`HEAD`/`POST`.
* `headers` – forwarded header map (sanitised before use).
* `bodyB64` – Base64URL encoded payload (ignored for `GET`/`HEAD`).
* `responseType` – `arrayBuffer` | `text` | `json` | `none`.

Execution flow:

1. Validate inputs, decode bodies if necessary.
2. Clone and enrich headers (browser defaults + cookies).
3. Perform the upstream fetch with `redirect: 'follow'` and catch network errors.
4. Persist any `Set-Cookie` values and attach an encoded `X-Set-Cookie` header to
   the sub-result and the batch response.
5. Materialise the body only if `responseType` requests it. `arrayBuffer` is
   encoded to Base64; `text` and `json` decode the bytes with a shared
   `TextDecoder`.

The final JSON payload contains telemetry (`durationMs`, `redirected`) to help
callers diagnose slow upstreams.

### Cookie Storage (`src/session_do.ts`)

Durable Object responsibilities:

* Maintain a map of origin → cookie name/value pairs.
* Provide `/getCookieHeader` for the worker to read cookies on demand.
* Provide `/mergeSetCookies` to merge and store new cookies.

The implementation is intentionally simple: path/domain scoping is collapsed to
per-origin storage. If we ever need finer control we can extend
`parseSetCookie` to honour `Domain`/`Path`/`Expires` attributes.

### Utilities (`src/utils.ts`)

Notable helpers:

* `base64urlDecodeToUint8Array` / `arrayBufferToBase64` – Binary-safe transfers
  for body payloads.
* `applyBrowserHeaderDefaults` – Shared logic for header enrichment.
* `headersToObject` – Converts `Headers` into plain objects for JSON responses.

`safeResponseHeaders` now includes `x-set-cookie` so that filtered headers retain
our encoded cookie values.

## Adding New Features

1. Reuse the helper functions in `index.ts` where possible. For example, new
   routes that fetch upstream resources should call
   `enrichHeadersForUpstream` + `persistSetCookies` to stay consistent.
2. Keep validation strict. Always verify `https` targets and supported HTTP
   methods, and guard against malformed Base64 payloads.
3. Think about streaming vs. buffering. For UI-critical flows prefer streaming
   endpoints. For data post-processing (e.g., connectors needing JSON), use
   `responseType` or introduce a separate flow where buffering is acceptable.
4. Update `doc/connector-guide.md` whenever the external contract changes.

## Local Development & Testing

* Install dependencies – `npm install`
* Type-check – `npm run typecheck`
* Run locally – `npm run dev`
* Dry-run deploy bundle – `npm run build`

There are no automated tests yet. When contributing significant features, try to
exercise routes manually with `curl` or write ad-hoc integration scripts.

## Troubleshooting Tips

* **Unexpected 0/FETCH_ERROR entries** – Usually DNS or TLS failures. Verify the
  target is publicly reachable from Cloudflare workers.
* **Cookies missing** – Ensure the `SESSION_DO` binding is configured in
  `wrangler.toml` and that the connector respects `X-Set-Cookie` headers.
* **Huge batch payloads** – `POST /dispatch` buffers responses. Keep per-request
  payloads modest (<10 MB) or split them across multiple calls to avoid hitting
  worker memory limits.

Happy routing! Feel free to expand this document as the project evolves.
