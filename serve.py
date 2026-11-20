"""
本地轻量预览与局域网分享服务
用法：
    python serve.py [port]           # 仅本机访问 http://127.0.0.1:8080
    python serve.py 8080 --lan       # 允许同局域网(Wi-Fi/办公室)他人访问 http://<本机局域网IP>:8080
安全说明：
    仅允许本机 (127.0.0.1 / ::1) 调用 POST /api/refresh 触发爬虫更新，外部访客仅限只读浏览。
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
UPDATE_LOCK = threading.Lock()
LOCAL_CLIENTS = {"127.0.0.1", "::1", "localhost"}


def get_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def end_headers(self):
        if self.path.startswith("/data/") or self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def _is_local_client(self) -> bool:
        return self.client_address[0] in LOCAL_CLIENTS

    def do_GET(self):
        if self.path.split("?")[0] == "/api/status":
            self._send_json(200, {"ok": True, "can_refresh": self._is_local_client()})
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/refresh":
            if not self._is_local_client():
                self._send_json(403, {"ok": False, "error": "仅限本机管理员触发数据抓取"})
                return
            if not UPDATE_LOCK.acquire(blocking=False):
                self._send_json(409, {"ok": False, "error": "已有更新任务正在运行，请稍候"})
                return
            try:
                proc = subprocess.run(
                    [sys.executable, str(ROOT_DIR / "scripts" / "update_daily.py")],
                    cwd=str(ROOT_DIR),
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
                if proc.returncode == 0:
                    self._send_json(200, {"ok": True, "log": proc.stdout[-1200:]})
                else:
                    self._send_json(500, {"ok": False, "error": proc.stderr[-800:] or proc.stdout[-800:]})
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            finally:
                UPDATE_LOCK.release()
            return
        self.send_error(404, "Not Found")

    def _send_json(self, status: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class SafeHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False


def main():
    args = sys.argv[1:]
    lan_mode = "--lan" in args
    port_args = [a for a in args if a.isdigit()]
    port = int(port_args[0]) if port_args else 8080
    host = "0.0.0.0" if lan_mode else "127.0.0.1"

    server = SafeHTTPServer((host, port), DashboardHandler)
    print(f"主市场看板（4大项目）: http://127.0.0.1:{port}/")
    print(f"黄金宏观独立看板:     http://127.0.0.1:{port}/gold.html")
    print(f"燕东微独立看板:       http://127.0.0.1:{port}/yandongwei.html")
    if lan_mode:
        lan_ip = get_lan_ip()
        print(f"局域网主市场看板:     http://{lan_ip}:{port}/")
        print(f"局域网黄金宏观看板:   http://{lan_ip}:{port}/gold.html")
        print(f"局域网燕东微看板:     http://{lan_ip}:{port}/yandongwei.html")
    print("按 Ctrl+C 停止服务")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")


if __name__ == "__main__":
    main()
