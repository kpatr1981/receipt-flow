#!/usr/bin/env python3
"""Static server for Receipt Flow (web/dist). Read-only, no uploads: photos never leave the browser."""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")  # revalidate: new deploys show up at once
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def list_directory(self, path):  # no folder listings
        self.send_error(404)
        return None

    def log_message(self, fmt, *args):  # journald gets a short line per request
        print(f"{self.client_address[0]} {fmt % args}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--port", type=int, default=8095)
    ap.add_argument("--bind", default="0.0.0.0")
    a = ap.parse_args()
    server = ThreadingHTTPServer((a.bind, a.port), functools.partial(Handler, directory=a.root))
    print(f"Receipt Flow on http://{a.bind}:{a.port}/ serving {a.root}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
