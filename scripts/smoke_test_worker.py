#!/usr/bin/env python3
"""
Smoke tests for the Cloudflare worker running locally at http://127.0.0.1:8787
Covers:
- GET/HEAD /p (base64url encoded https target), Range passthrough
- POST /fetch (GET and POST bodies, header filtering, cookie capture via X-Set-Cookie)
- POST /dispatch (batch sequential/parallel behavior)

Usage:
  python scripts/smoke_test_worker.py

Optional env:
  WORKER_BASE=http://127.0.0.1:8787
  SID=smoke-sid
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, List, Tuple

WORKER_BASE = os.getenv("WORKER_BASE", "http://127.0.0.1:8787").rstrip("/")
SID = os.getenv("SID", "smoke-sid")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def http_request(url: str, method: str = "GET", headers: Dict[str, str] = None, data: bytes = None,
                 timeout: float = 30.0) -> Tuple[int, Dict[str, List[str]], bytes]:
    headers = headers or {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.getcode()
            # Collect headers (case-insensitive, preserve duplicates)
            hdrs_multi: Dict[str, List[str]] = {}
            for k in resp.headers.keys():
                for v in resp.headers.get_all(k) or []:
                    hdrs_multi.setdefault(k.lower(), []).append(v)
            body = resp.read()
            return status, hdrs_multi, body
    except urllib.error.HTTPError as e:
        # HTTPError is also a response with body
        status = e.code
        hdrs_multi: Dict[str, List[str]] = {}
        for k in e.headers.keys():
            for v in e.headers.get_all(k) or []:
                hdrs_multi.setdefault(k.lower(), []).append(v)
        body = e.read()
        return status, hdrs_multi, body
    except Exception as e:
        raise RuntimeError(f"Network error while requesting {url}: {e}")


def log_ok(name: str):
    print(f"[PASS] {name}")


def log_warn(name: str, msg: str):
    print(f"[WARN] {name}: {msg}")


def log_fail(name: str, msg: str):
    print(f"[FAIL] {name}: {msg}")


def test_p_basic() -> None:
    name = "GET /p basic"
    target = "https://httpbin.org/image/png"
    u = b64url(target.encode("utf-8"))
    url = f"{WORKER_BASE}/p?sid={urllib.parse.quote(SID)}&u={urllib.parse.quote(u)}"
    status, headers, body = http_request(url, "GET")
    if status != 200:
        raise AssertionError(f"Expected 200, got {status}")
    ctype = ", ".join(headers.get("content-type", []))
    if "image/png" not in ctype.lower():
        raise AssertionError(f"Expected Content-Type image/png, got {ctype}")
    if len(body) == 0:
        raise AssertionError("Empty body")
    log_ok(name)


def test_p_range() -> None:
    name = "GET /p with Range"
    target = "https://httpbin.org/range/2048"  # dynamic bytes
    u = b64url(target.encode("utf-8"))
    url = f"{WORKER_BASE}/p?sid={urllib.parse.quote(SID)}&u={urllib.parse.quote(u)}"
    headers = {"Range": "bytes=0-99"}
    status, hdrs, body = http_request(url, "GET", headers=headers)
    if status == 206:
        cr = ", ".join(hdrs.get("content-range", []))
        if not cr or "bytes" not in cr:
            raise AssertionError(f"Expected Content-Range bytes, got {cr}")
        if len(body) != 100:
            # Some servers may send more; accept >= 100 but warn
            if len(body) < 100:
                raise AssertionError(f"Expected 100 bytes, got {len(body)}")
            else:
                log_warn(name, f"Body length {len(body)} != 100, upstream behavior")
        log_ok(name)
    else:
        # Some upstreams may not honor Range; don't fail the suite
        log_warn(name, f"Upstream did not return 206 (got {status}).")


def test_fetch_get_html() -> None:
    name = "POST /fetch GET HTML"
    target = "https://example.com/"
    payload = {
        "sid": SID,
        "target": target,
        "method": "GET",
        "headers": {"Accept": "text/html"},
    }
    body = json.dumps(payload).encode("utf-8")
    url = f"{WORKER_BASE}/fetch"
    status, headers, resp_body = http_request(url, "POST", headers={"Content-Type": "application/json"}, data=body)
    if status != 200:
        raise AssertionError(f"Expected 200, got {status}")
    ctype = ", ".join(headers.get("content-type", []))
    if "text/html" not in ctype.lower():
        raise AssertionError(f"Expected Content-Type text/html, got {ctype}")
    if len(resp_body) == 0:
        raise AssertionError("Empty body")
    log_ok(name)


def test_fetch_post_json() -> None:
    name = "POST /fetch POST JSON"
    target = "https://httpbin.org/post"
    payload_json = json.dumps({"hello": "world"}).encode("utf-8")
    body_b64 = b64url(payload_json)
    payload = {
        "sid": SID,
        "target": target,
        "method": "POST",
        "headers": {"Content-Type": "application/json", "Accept": "application/json"},
        "bodyB64": body_b64,
    }
    url = f"{WORKER_BASE}/fetch"
    status, headers, resp_body = http_request(url, "POST", headers={"Content-Type": "application/json"}, data=json.dumps(payload).encode("utf-8"))
    if status != 200:
        raise AssertionError(f"Expected 200, got {status}")
    try:
        data = json.loads(resp_body.decode("utf-8"))
    except Exception as e:
        raise AssertionError(f"Expected JSON echo, parse error: {e}")
    if data.get("json", {}).get("hello") != "world":
        raise AssertionError("JSON echo mismatch")
    log_ok(name)


def test_fetch_cookies() -> None:
    name = "/fetch cookies set -> X-Set-Cookie + optional persistence"
    # 1) Trigger upstream Set-Cookie
    set_url = "https://httpbin.org/response-headers?Set-Cookie=foo=bar"
    payload = {"sid": SID, "target": set_url, "method": "GET", "headers": {"Accept": "*/*"}}
    status, headers, _ = http_request(f"{WORKER_BASE}/fetch", "POST", headers={"Content-Type": "application/json"}, data=json.dumps(payload).encode("utf-8"))
    if status != 200:
        raise AssertionError(f"Expected 200 on cookie set, got {status}")
    xsc = headers.get("x-set-cookie", [])
    if not xsc:
        raise AssertionError("Expected X-Set-Cookie header from worker")

    # 2) Check cookie persistence (only if DO is enabled). Not a hard failure if absent.
    get_url = "https://httpbin.org/cookies"
    payload2 = {"sid": SID, "target": get_url, "method": "GET", "headers": {"Accept": "application/json"}}
    status2, headers2, body2 = http_request(f"{WORKER_BASE}/fetch", "POST", headers={"Content-Type": "application/json"}, data=json.dumps(payload2).encode("utf-8"))
    if status2 == 200:
        try:
            data = json.loads(body2.decode("utf-8"))
            cookies = data.get("cookies", {})
            if cookies.get("foo") == "bar":
                log_ok(name + " (persisted)")
            else:
                log_warn(name, "Cookie not persisted (Durable Object likely disabled).")
        except Exception:
            log_warn(name, "Failed to parse cookie JSON; skipping persistence check.")
    else:
        log_warn(name, f"Cookie check fetch returned {status2}; skipping parse.")


def test_dispatch_batch() -> None:
    name = "POST /dispatch batch"
    url = f"{WORKER_BASE}/dispatch"
    requests_list = [
        {
            "id": "one",
            "target": "https://httpbin.org/get",
            "method": "GET",
            "headers": {"Accept": "application/json"},
            "responseType": "json",
        },
        {
            "id": "two",
            "target": "https://example.com/",
            "method": "GET",
            "headers": {"Accept": "text/html"},
            "responseType": "text",
        },
    ]
    payload = {"sid": SID, "pipeline": "parallel", "requests": requests_list}
    status, headers, body = http_request(url, "POST", headers={"Content-Type": "application/json"}, data=json.dumps(payload).encode("utf-8"))
    if status != 200:
        raise AssertionError(f"Expected 200, got {status}")
    try:
        data = json.loads(body.decode("utf-8"))
    except Exception as e:
        raise AssertionError(f"Expected JSON batch result, parse error: {e}")
    if not isinstance(data.get("results"), list) or len(data["results"]) != 2:
        raise AssertionError("Batch results length mismatch")
    # Spot check results entries
    ids = {r.get("id"): r for r in data["results"]}
    if "one" not in ids or "two" not in ids:
        raise AssertionError("Missing result ids")
    log_ok(name)


def test_common_sites_ok() -> None:
    name = "Common sites 200 via /fetch"
    targets = [
        ("bilibili", "https://www.bilibili.com/"),
        ("zhihu", "https://www.zhihu.com/"),
        ("google", "https://www.google.com/"),
    ]
    url = f"{WORKER_BASE}/fetch"
    failures: List[str] = []
    for key, target in targets:
        payload = {
            "sid": SID,
            "target": target,
            "method": "GET",
            "headers": {"Accept": "text/html"},
        }
        status, headers, body = http_request(
            url, "POST", headers={"Content-Type": "application/json"}, data=json.dumps(payload).encode("utf-8")
        )
        if status != 200:
            failures.append(f"{key}: status {status}")
            continue
        ctype = ", ".join(headers.get("content-type", []))
        if "text/html" not in ctype.lower():
            failures.append(f"{key}: unexpected content-type {ctype}")
            continue
        if len(body) == 0:
            failures.append(f"{key}: empty body")
    if failures:
        raise AssertionError("; ".join(failures))
    log_ok(name)


def main() -> int:
    print(f"Worker base: {WORKER_BASE}")
    print(f"SID: {SID}")

    failures = 0
    tests = [
        test_p_basic,
        test_p_range,
        test_fetch_get_html,
        test_fetch_post_json,
        test_fetch_cookies,
        test_dispatch_batch,
        test_common_sites_ok,
    ]

    for t in tests:
        try:
            t()
            time.sleep(0.05)
        except AssertionError as ae:
            failures += 1
            log_fail(t.__name__, str(ae))
        except RuntimeError as re:
            failures += 1
            log_fail(t.__name__, str(re))
        except Exception as e:
            failures += 1
            log_fail(t.__name__, f"Unexpected error: {e}")

    print("")
    if failures == 0:
        print("All smoke tests passed.")
    else:
        print(f"{failures} test(s) failed.")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
