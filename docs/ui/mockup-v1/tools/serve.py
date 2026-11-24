#!/usr/bin/env python3
"""Static server for the UI mockup preview (port 4173).

Like `python3 -m http.server`, but every response is directly readable by
any client, including the preview platform's reachability checks:

* always a full `200` with the body - conditional requests
  (If-Modified-Since / If-None-Match) never get an empty `304`;
* `Cache-Control: no-store` - nothing is cached, so a reload always shows
  the latest mockup files;
* `Access-Control-Allow-Origin: *` and an `OPTIONS` (CORS preflight)
  handler - cross-origin checks can read the response.

This only serves a static design mockup (no credentials, no private data),
so the permissive CORS header is safe here.

Usage (from docs/ui/mockup-v1/tools):
  python3 serve.py --bind 0.0.0.0 --port 4173 --directory ..
"""
import argparse
import functools
import http.server


class PreviewHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def send_head(self):
        # Drop validators so the stdlib handler never answers 304.
        for name in ("If-Modified-Since", "If-None-Match"):
            del self.headers[name]
        return super().send_head()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=4173)
    ap.add_argument("--directory", default="..")
    a = ap.parse_args()
    handler = functools.partial(PreviewHandler, directory=a.directory)
    with http.server.ThreadingHTTPServer((a.bind, a.port), handler) as httpd:
        print(f"Serving {a.directory} on http://{a.bind}:{a.port}/ "
              "(always 200, no-store, CORS *)", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
