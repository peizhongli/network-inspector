#!/usr/bin/env python3
"""
Network Inspector Mock Server（零依赖，仅用 Python 标准库）

启动：
    python3 mock/server.py            # 默认 8899 端口
    PORT=9000 python3 mock/server.py

端点：
    GET  /                      mock 页面
    GET  /api/json              嵌套 JSON + 自定义响应头
    GET  /api/array             JSON 数组（12 项）
    GET  /api/large             超过 1MB 的 JSON（验证超大响应保护）
    GET  /api/binary            2MB 二进制流（octet-stream）
    GET  /api/image.png         1x1 PNG
    GET  /api/error             500 JSON
    GET  /api/slow              800ms 延迟
    GET  /api/sse               text/event-stream
    GET  /api/redirect          302 → /api/json
    POST /api/echo              JSON 回显（读取 X-Debug-Token）
    POST /api/form              form-urlencoded 回显
    POST /api/multipart         multipart 回显字段名
"""

import json
import os
import time
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8899"))

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

# 约 1.2MB，用于验证“超过解析阈值不渲染树、只给下载”
LARGE_JSON = json.dumps(
    {
        "generated": "mock",
        "needle": "large-body-needle",
        "items": [
            {
                "id": i,
                "name": "item-%d" % i,
                "needle": "large-body-needle",
                "description": ("payload " * 55),
                "tags": ["alpha", "beta", "gamma"],
            }
            for i in range(2400)
        ],
    },
    ensure_ascii=False,
).encode("utf-8")

BINARY_BODY = (b"0123456789abcdef" * (2 * 1024 * 1024 // 16))


def array_payload():
    return [
        {
            "id": i,
            "name": "row-%02d" % i,
            "needle": "array-needle-%d" % i,
            "nested": {"enabled": i % 2 == 0, "values": [i, i + 1, i + 2]},
        }
        for i in range(1, 13)
    ]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("[mock] " + (fmt % args))

    def _send(self, status, body, content_type, extra_headers=None):
        data = body if isinstance(body, bytes) else str(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, payload, status=200, headers=None):
        body = json.dumps(payload, ensure_ascii=False)
        merged = {
            "X-Debug-Token": "mock-token-123",
            "X-Custom-Flag": "custom-header-present",
        }
        merged.update(headers or {})
        self._send(status, body, "application/json; charset=utf-8", merged)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/":
            try:
                with open(os.path.join(HERE, "mock.html"), "rb") as handle:
                    self._send(200, handle.read(), "text/html; charset=utf-8")
            except OSError:
                self._send(404, "mock.html not found", "text/plain")
            return

        if path == "/api/json":
            self._json(
                {
                    "needle": "header-payload-response",
                    "nested": {
                        "needle": "search-me",
                        "array": [1, 2, 3],
                        "object": {"a": True, "b": None, "c": "中文内容"},
                    },
                    "items": [{"id": i, "label": "item-%d" % i} for i in range(5)],
                }
            )
            return

        if path == "/api/array":
            self._json(array_payload(), headers={"X-Array-Count": "12"})
            return

        if path == "/api/large":
            self._send(
                200,
                LARGE_JSON,
                "application/json; charset=utf-8",
                {"X-Payload-Size": str(len(LARGE_JSON))},
            )
            return

        if path == "/api/binary":
            self._send(
                200,
                BINARY_BODY,
                "application/octet-stream",
                {
                    "Content-Disposition": 'attachment; filename="mock-binary.bin"',
                    "X-Binary-Note": "raw-bytes",
                },
            )
            return

        if path == "/api/image.png":
            self._send(200, PNG_1PX, "image/png", {"X-Image-Note": "1x1"})
            return

        if path == "/api/error":
            self._json({"message": "mock server error", "needle": "error-search"}, status=500)
            return

        if path == "/api/slow":
            time.sleep(0.8)
            self._json({"ok": True, "needle": "slow-request", "delay": 0.8})
            return

        if path == "/api/redirect":
            self.send_response(302)
            self.send_header("Location", "/api/json")
            self.send_header("X-Redirect-Note", "mock-redirect")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if path == "/api/sse":
            self._sse()
            return

        # 复现用户真实场景：关键字只出现在 URL path 中（body / header 都不含）
        if path == "/api-dev/qfc-business-pmc/project/teamConfigView/getTeamConfigOrgTree":
            self._json({"code": 0, "msg": "ok", "data": {"orgTree": [{"id": "org-1", "name": "总部"}]}})
            return

        self._send(404, "not found", "text/plain; charset=utf-8")

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Stream-Id", "mock-sse")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            for i in range(4):
                payload = (
                    "event: tick\ndata: "
                    + json.dumps({"n": i, "needle": "sse-search", "ts": time.time()})
                    + "\n\n"
                ).encode("utf-8")
                self.wfile.write(b"%x\r\n" % len(payload) + payload + b"\r\n")
                self.wfile.flush()
                time.sleep(0.25)
            tail = b'event: done\ndata: {"ok": true}\n\n'
            self.wfile.write(b"%x\r\n" % len(tail) + tail + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if path == "/api/echo":
            try:
                received = json.loads(raw.decode("utf-8") or "{}")
            except ValueError:
                received = {"raw": raw.decode("utf-8", "replace")}
            self._json(
                {
                    "ok": True,
                    "received": received,
                    "token": self.headers.get("X-Debug-Token", ""),
                },
                headers={"X-Echo-Token": self.headers.get("X-Debug-Token", "")},
            )
            return

        if path == "/api/form":
            self._json({"ok": True, "received": raw.decode("utf-8", "replace")})
            return

        if path == "/api/multipart":
            text = raw.decode("utf-8", "replace")
            fields = []
            for chunk in text.split('name="')[1:]:
                fields.append(chunk.split('"')[0])
            self._json({"ok": True, "fields": fields, "size": len(raw)})
            return

        if path == "/api/custom":
            self._json(
                {"ok": True, "debug": self.headers.get("X-Debug-Token", "")},
                headers={"X-Server-Marker": "from-post"},
            )
            return

        # 复现用户真实场景：POST + 200 + application/json，关键字只在 URL path 中
        if path == "/api-dev/qfc-business-pmc/project/teamConfigView/getTeamConfigOrgTree":
            self._json({
                "code": 0,
                "msg": "ok",
                "data": {
                    "orgTree": [{"id": "org-1", "name": "总部", "children": []}],
                    "received": raw.decode("utf-8", "replace"),
                },
            })
            return

        self._send(404, "not found", "text/plain; charset=utf-8")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("Network Inspector Mock 已启动： http://127.0.0.1:%d/" % PORT)
    print("LARGE_JSON = %.2f MB, BINARY = %.2f MB" % (len(LARGE_JSON) / 1048576, len(BINARY_BODY) / 1048576))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
