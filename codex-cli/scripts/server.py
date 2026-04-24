#!/usr/bin/env python3

import base64
import hashlib
import json
import os
import pty
import queue
import re
import select
import shlex
import socket
import struct
import subprocess
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, unquote, urlparse, urlunparse
from urllib.request import Request, urlopen

try:
    import fcntl
    import termios
except ImportError:  # pragma: no cover
    fcntl = None
    termios = None


ALLOWED_IMAGE_TYPES = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


def now_ms():
    return int(time.time() * 1000)


def env_int(name, default):
    value = os.environ.get(name)
    if value in {None, ""}:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def safe_filename(name):
    stem = Path(name or "image").stem
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", stem).strip(".-")
    return stem[:80] or "image"


def read_exact(sock, length):
    chunks = []
    remaining = length
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise ConnectionError("Socket closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class WebSocket:
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, handler):
        self.handler = handler
        self.sock = handler.connection
        self.write_lock = threading.Lock()

    def accept(self):
        key = self.handler.headers.get("Sec-WebSocket-Key", "")
        digest = hashlib.sha1((key + self.GUID).encode("ascii")).digest()
        accept_key = base64.b64encode(digest).decode("ascii")
        self.handler.send_response(HTTPStatus.SWITCHING_PROTOCOLS)
        self.handler.send_header("Upgrade", "websocket")
        self.handler.send_header("Connection", "Upgrade")
        self.handler.send_header("Sec-WebSocket-Accept", accept_key)
        self.handler.end_headers()
        self.handler.close_connection = True

    def recv(self):
        header = read_exact(self.sock, 2)
        first, second = header
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", read_exact(self.sock, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", read_exact(self.sock, 8))[0]
        mask = read_exact(self.sock, 4) if masked else b""
        payload = read_exact(self.sock, length) if length else b""
        if masked:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))

        if opcode == 0x8:
            return None
        if opcode == 0x9:
            self._send_frame(payload, 0xA)
            return {"type": "ping"}
        if opcode == 0xA:
            return {"type": "pong"}
        if opcode == 0x1:
            return json.loads(payload.decode("utf-8"))
        if opcode == 0x2:
            return {"type": "input", "data": payload.decode("utf-8", errors="replace")}
        return {"type": "unknown"}

    def send_text(self, data):
        self._send_frame(data.encode("utf-8", errors="replace"), 0x1)

    def close(self):
        try:
            self._send_frame(b"", 0x8)
        except OSError:
            pass

    def _send_frame(self, payload, opcode):
        first = 0x80 | opcode
        length = len(payload)
        if length < 126:
            header = struct.pack("!BB", first, length)
        elif length < 65536:
            header = struct.pack("!BBH", first, 126, length)
        else:
            header = struct.pack("!BBQ", first, 127, length)
        with self.write_lock:
            self.sock.sendall(header + payload)


class CodexProtocolError(RuntimeError):
    pass


class CodexAuthServer:
    def __init__(self, app):
        self.app = app
        self.proc = None
        self.write_lock = threading.Lock()
        self.pending_lock = threading.Lock()
        self.pending = {}
        self.next_request_id = 1

    def start(self):
        if self.proc is not None and self.proc.poll() is None:
            return

        argv = ["codex", "app-server"]
        self.proc = subprocess.Popen(
            argv,
            cwd=self.app.workspace,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=os.environ.copy(),
        )
        threading.Thread(target=self._read_stdout, name="codex-auth-stdout", daemon=True).start()
        threading.Thread(target=self._read_stderr, name="codex-auth-stderr", daemon=True).start()

        self.request(
            "initialize",
            {
                "clientInfo": {"name": "codex-cli-ha", "title": "Codex CLI HA", "version": "0.1.0"},
                "capabilities": {"experimentalApi": True},
            },
            timeout=30,
        )
        self.notify({"method": "initialized"})

    def request(self, method, params=None, timeout=120):
        request_id = self._allocate_id()
        event = threading.Event()
        holder = {"message": None}
        with self.pending_lock:
            self.pending[request_id] = (event, holder)
        payload = {"id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        self._send(payload)
        if not event.wait(timeout):
            with self.pending_lock:
                self.pending.pop(request_id, None)
            raise TimeoutError(f"Timed out waiting for Codex response to {method}")
        message = holder["message"]
        if "error" in message:
            error = message["error"]
            raise CodexProtocolError(error.get("message", str(error)))
        return message.get("result")

    def notify(self, payload):
        self._send(payload)

    def _allocate_id(self):
        with self.pending_lock:
            request_id = self.next_request_id
            self.next_request_id += 1
            return request_id

    def _send(self, payload):
        if self.proc is None or self.proc.stdin is None:
            raise CodexProtocolError("Codex auth server is not running")
        with self.write_lock:
            self.proc.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
            self.proc.stdin.flush()

    def _read_stdout(self):
        assert self.proc is not None and self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self.app.add_log(f"codex: {line}")
                continue
            self._dispatch(message)
        self.app.add_log("Codex auth app-server stopped")

    def _read_stderr(self):
        assert self.proc is not None and self.proc.stderr is not None
        for line in self.proc.stderr:
            line = line.strip()
            if line:
                self.app.add_log(line)

    def _dispatch(self, message):
        request_id = message.get("id")
        if request_id is not None and ("result" in message or "error" in message):
            with self.pending_lock:
                pending = self.pending.pop(request_id, None)
            if pending:
                event, holder = pending
                holder["message"] = message
                event.set()
                return

        method = message.get("method")
        params = message.get("params") or {}
        if method == "account/login/completed":
            self.app.set_auth_state(
                {
                    "type": "completed",
                    "success": params.get("success"),
                    "error": params.get("error"),
                    "completedAt": now_ms(),
                }
            )
        elif method == "account/updated":
            self.app.add_log(f"account updated: {json.dumps(params)}")
        elif method:
            self.app.add_log(f"{method}: {json.dumps(params)[:500]}")


class App:
    def __init__(self):
        self.host = os.environ.get("CODEX_SERVER_HOST", "0.0.0.0")
        self.port = env_int("CODEX_SERVER_PORT", 7681)
        self.workspace = os.environ.get("CODEX_WORKSPACE", "/config")
        self.session_name = os.environ.get("CODEX_SESSION_NAME", "codex-cli")
        self.image_dir = Path(os.environ.get("CODEX_IMAGE_DIR", "/data/codex-images"))
        self.web_dir = Path(os.environ.get("CODEX_WEB_DIR", "/opt/codex-cli-ha/web"))
        self.vendor_dir = Path(os.environ.get("CODEX_VENDOR_DIR", "/opt/codex-cli-ha/vendor"))
        self.max_upload_bytes = env_int("CODEX_MAX_UPLOAD_MB", 25) * 1024 * 1024
        self.font_size = env_int("CODEX_TERMINAL_FONT_SIZE", 14)
        self.auth = CodexAuthServer(self)
        self.logs = queue.Queue(maxsize=200)
        self.auth_state = None
        self.image_dir.mkdir(parents=True, exist_ok=True)

    def serve(self):
        server = ThreadingHTTPServer((self.host, self.port), self._handler())
        server.daemon_threads = True
        print(f"Codex CLI HA listening on {self.host}:{self.port}", flush=True)
        server.serve_forever()

    def add_log(self, line):
        item = {"time": now_ms(), "line": str(line)}
        try:
            self.logs.put_nowait(item)
        except queue.Full:
            try:
                self.logs.get_nowait()
            except queue.Empty:
                pass
            self.logs.put_nowait(item)

    def set_auth_state(self, state):
        self.auth_state = state

    def snapshot(self):
        return {
            "workspace": self.workspace,
            "sessionName": self.session_name,
            "imageDir": str(self.image_dir),
            "maxUploadMb": self.max_upload_bytes // 1024 // 1024,
            "fontSize": self.font_size,
            "auth": self.auth_state,
            "logs": list(self.logs.queue),
        }

    def upload_image(self, payload):
        mime = payload.get("type") or ""
        if mime not in ALLOWED_IMAGE_TYPES:
            raise ValueError(f"Unsupported image type: {mime}")
        raw_b64 = payload.get("data") or ""
        data = base64.b64decode(raw_b64, validate=True)
        if len(data) > self.max_upload_bytes:
            raise ValueError(f"Image exceeds {self.max_upload_bytes // 1024 // 1024} MB limit")
        filename = f"{int(time.time())}-{uuid.uuid4().hex[:10]}-{safe_filename(payload.get('name'))}{ALLOWED_IMAGE_TYPES[mime]}"
        path = self.image_dir / filename
        path.write_bytes(data)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return {
            "name": filename,
            "path": str(path),
            "shellPath": shlex.quote(str(path)),
            "size": len(data),
            "type": mime,
        }

    def start_login(self, payload):
        login_type = payload.get("type") or "chatgpt"
        if login_type == "apiKey":
            api_key = payload.get("apiKey") or os.environ.get("OPENAI_API_KEY")
            if not api_key:
                raise ValueError("API key is required")
            params = {"type": "apiKey", "apiKey": api_key}
        elif login_type == "chatgptDeviceCode":
            params = {"type": "chatgptDeviceCode"}
        else:
            params = {"type": "chatgpt"}

        self.auth.start()
        result = self.auth.request("account/login/start", params, timeout=60)
        state = dict(result)
        state["startedAt"] = now_ms()
        if login_type == "apiKey":
            state["apiKey"] = None
        self.set_auth_state(state)
        return result

    def forward_callback(self, payload):
        callback_url = (payload.get("url") or "").strip()
        parsed = urlparse(callback_url)
        if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("Paste the failed http://localhost callback URL from the browser address bar")
        if not parsed.port:
            raise ValueError("Callback URL must include the localhost port")

        target = urlunparse(("http", f"127.0.0.1:{parsed.port}", parsed.path or "/", "", parsed.query, parsed.fragment))
        request = Request(target, headers={"Host": f"localhost:{parsed.port}", "User-Agent": "codex-cli-ha/0.1"})
        try:
            with urlopen(request, timeout=15) as response:
                body = response.read(4096).decode("utf-8", errors="replace")
                status = response.status
        except HTTPError as exc:
            body = exc.read(4096).decode("utf-8", errors="replace")
            status = exc.code
            if "cancel" in body.lower():
                raise ValueError(
                    "Codex rejected the callback as cancelled. Start a new ChatGPT Login and forward the full localhost URL immediately."
                ) from exc
        return {"status": status, "body": body}

    def login_status(self):
        try:
            result = subprocess.run(
                ["codex", "login", "status"],
                cwd=self.workspace,
                env=os.environ.copy(),
                text=True,
                capture_output=True,
                timeout=20,
                check=False,
            )
            return {"code": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
        except Exception as exc:
            return {"code": 1, "stdout": "", "stderr": str(exc)}

    def handle_terminal_ws(self, handler):
        ws = WebSocket(handler)
        ws.accept()
        child_pid, pty_fd = self._spawn_tmux()
        self._set_pty_size(pty_fd, 30, 120)
        sock = handler.connection
        try:
            while True:
                readable, _, _ = select.select([pty_fd, sock], [], [], 30)
                if not readable:
                    continue
                if pty_fd in readable:
                    try:
                        data = os.read(pty_fd, 8192)
                    except OSError:
                        break
                    if not data:
                        break
                    ws.send_text(data.decode("utf-8", errors="replace"))
                if sock in readable:
                    try:
                        message = ws.recv()
                    except (ConnectionError, OSError, json.JSONDecodeError):
                        break
                    if message is None:
                        break
                    self._handle_ws_message(pty_fd, message)
        finally:
            try:
                os.close(pty_fd)
            except OSError:
                pass
            try:
                os.waitpid(child_pid, 0)
            except ChildProcessError:
                pass
            ws.close()

    def _spawn_tmux(self):
        child_pid, pty_fd = pty.fork()
        if child_pid == 0:
            env = os.environ.copy()
            env.setdefault("TERM", "xterm-256color")
            env.setdefault("COLORTERM", "truecolor")
            os.chdir(self.workspace)
            command = [
                "tmux",
                "new-session",
                "-A",
                "-s",
                self.session_name,
                "/opt/codex-cli-ha/scripts/codex-shell.sh",
            ]
            os.execvpe(command[0], command, env)
        return child_pid, pty_fd

    def _handle_ws_message(self, pty_fd, message):
        message_type = message.get("type")
        if message_type == "input":
            os.write(pty_fd, str(message.get("data", "")).encode("utf-8", errors="replace"))
        elif message_type == "resize":
            rows = int(message.get("rows") or 30)
            cols = int(message.get("cols") or 120)
            self._set_pty_size(pty_fd, rows, cols)

    def _set_pty_size(self, pty_fd, rows, cols):
        if not fcntl or not termios:
            return
        rows = max(1, min(rows, 200))
        cols = max(1, min(cols, 500))
        fcntl.ioctl(pty_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def _handler(self):
        app = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "CodexCLIHA/0.1"

            def log_message(self, fmt, *args):
                app.add_log("%s - %s" % (self.client_address[0], fmt % args))

            def do_GET(self):
                parsed = urlparse(self.path)
                path = parsed.path
                if path in {"", "/"}:
                    self._serve_file(app.web_dir / "index.html", "text/html; charset=utf-8")
                elif path == "/app.js":
                    self._serve_file(app.web_dir / "app.js", "application/javascript; charset=utf-8")
                elif path == "/styles.css":
                    self._serve_file(app.web_dir / "styles.css", "text/css; charset=utf-8")
                elif path == "/vendor/xterm.css":
                    self._serve_file(app.vendor_dir / "xterm.css", "text/css; charset=utf-8")
                elif path == "/vendor/xterm.js":
                    self._serve_file(app.vendor_dir / "xterm.js", "application/javascript; charset=utf-8")
                elif path == "/vendor/xterm-addon-fit.js":
                    self._serve_file(app.vendor_dir / "xterm-addon-fit.js", "application/javascript; charset=utf-8")
                elif path == "/api/state":
                    self._json(app.snapshot())
                elif path == "/api/auth/status":
                    self._json({"ok": True, "status": app.login_status()})
                elif path.startswith("/api/image/"):
                    self._serve_image(path.removeprefix("/api/image/"))
                elif path == "/ws":
                    app.handle_terminal_ws(self)
                else:
                    self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

            def do_POST(self):
                parsed = urlparse(self.path)
                try:
                    payload = self._read_json()
                    if parsed.path == "/api/upload":
                        self._json({"ok": True, "image": app.upload_image(payload)})
                    elif parsed.path == "/api/auth/start":
                        self._json({"ok": True, "result": app.start_login(payload)})
                    elif parsed.path == "/api/auth/callback":
                        self._json({"ok": True, "result": app.forward_callback(payload)})
                    else:
                        self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
                except Exception as exc:
                    app.add_log(f"request failed: {exc}")
                    self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

            def _read_json(self):
                length = int(self.headers.get("Content-Length", "0"))
                if length > app.max_upload_bytes + 1024 * 1024:
                    raise ValueError("Request body is too large")
                body = self.rfile.read(length)
                if not body:
                    return {}
                return json.loads(body.decode("utf-8"))

            def _json(self, payload, status=HTTPStatus.OK):
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)

            def _serve_file(self, path, content_type):
                if not path.exists():
                    self._json({"error": f"Missing file: {path.name}"}, HTTPStatus.NOT_FOUND)
                    return
                data = path.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)

            def _serve_image(self, encoded_name):
                name = unquote(encoded_name)
                if "/" in name or "\\" in name:
                    self._json({"error": "Invalid image path"}, HTTPStatus.BAD_REQUEST)
                    return
                path = (app.image_dir / name).resolve()
                try:
                    if path.parent != app.image_dir.resolve() or not path.exists():
                        self._json({"error": "Image not found"}, HTTPStatus.NOT_FOUND)
                        return
                except OSError:
                    self._json({"error": "Image not found"}, HTTPStatus.NOT_FOUND)
                    return
                content_type = {
                    ".gif": "image/gif",
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".png": "image/png",
                    ".webp": "image/webp",
                }.get(path.suffix.lower(), "application/octet-stream")
                self._serve_file(path, content_type)

        return Handler


if __name__ == "__main__":
    App().serve()
