#!/usr/bin/env python3

import base64
import cgi
import hashlib
import json
import os
import pty
import queue
import re
import select
import shlex
import shutil
import struct
import subprocess
import threading
import time
import uuid
from urllib.error import HTTPError, URLError
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen

try:
    import fcntl
    import termios
except ImportError:  # pragma: no cover
    fcntl = None
    termios = None


ALLOWED_IMAGE_TYPES = {
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/tiff": ".tiff",
    "image/webp": ".webp",
}

IMAGE_TYPE_ALIASES = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "image/tif": "image/tiff",
    "image/x-ms-bmp": "image/bmp",
    "image/x-png": "image/png",
}

IMAGE_EXTENSION_TYPES = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webp": "image/webp",
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


def format_percent(value):
    try:
        return f"{float(value):.0f}%"
    except (TypeError, ValueError):
        return str(value)


def normalize_image_type(mime):
    value = (mime or "").split(";", 1)[0].strip().lower()
    return IMAGE_TYPE_ALIASES.get(value, value)


def detect_image_type(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"BM"):
        return "image/bmp"
    if data.startswith((b"II*\x00", b"MM\x00*")):
        return "image/tiff"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand in {b"avif", b"avis"}:
            return "image/avif"
        if brand in {b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}:
            return "image/heif"
    return ""


def infer_image_type(data, declared_mime, name):
    detected = detect_image_type(data)
    if detected:
        return detected
    declared = normalize_image_type(declared_mime)
    if declared in ALLOWED_IMAGE_TYPES:
        return declared
    suffix_type = IMAGE_EXTENSION_TYPES.get(Path(name or "").suffix.lower())
    if suffix_type:
        return suffix_type
    return declared


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


class CodexAppServer:
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
        threading.Thread(target=self._read_stdout, name="codex-app-stdout", daemon=True).start()
        threading.Thread(target=self._read_stderr, name="codex-app-stderr", daemon=True).start()

        self.request(
            "initialize",
            {
                "clientInfo": {"name": "codex-cli-ha", "title": "Codex CLI HA", "version": self.app.version},
                "capabilities": {"experimentalApi": True},
            },
            timeout=30,
        )
        self.notify({"method": "initialized"})

    def stop(self):
        if self.proc is None:
            return
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.proc = None

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
            raise CodexProtocolError("Codex app-server is not running")
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
        self.app.add_log("Codex app-server stopped")

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
        elif method == "account/rateLimits/updated":
            self.app.set_rate_limits(params.get("rateLimits"))
        elif method:
            self.app.add_log(f"{method}: {json.dumps(params)[:500]}")


class App:
    def __init__(self):
        self.host = os.environ.get("CODEX_SERVER_HOST", "0.0.0.0")
        self.port = env_int("CODEX_SERVER_PORT", 7681)
        self.workspace = os.environ.get("CODEX_WORKSPACE", "/config")
        self.codex_home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
        self.session_name = os.environ.get("CODEX_SESSION_NAME", "codex-cli")
        self.image_dir = Path(os.environ.get("CODEX_IMAGE_DIR", "/tmp/codex-images-tmp"))
        self.web_dir = Path(os.environ.get("CODEX_WEB_DIR", "/opt/codex-cli-ha/web"))
        self.vendor_dir = Path(os.environ.get("CODEX_VENDOR_DIR", "/opt/codex-cli-ha/vendor"))
        self.max_upload_bytes = env_int("CODEX_MAX_UPLOAD_MB", 25) * 1024 * 1024
        self.image_cleanup_seconds = max(0, env_int("CODEX_IMAGE_CLEANUP_SECONDS", 60))
        self.clipboard_display = os.environ.get("CODEX_CLIPBOARD_DISPLAY") or os.environ.get("DISPLAY")
        self.font_size = env_int("CODEX_TERMINAL_FONT_SIZE", 14)
        self.version = os.environ.get("CODEX_ADDON_VERSION", "0.1.5")
        self.codex = CodexAppServer(self)
        self.logs = queue.Queue(maxsize=200)
        self.auth_state = None
        self.rate_limits = None
        self.rate_limits_updated_at = None
        self.rate_limits_error = None
        self.ha_action = None
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

    def set_rate_limits(self, rate_limits):
        self.rate_limits = rate_limits
        self.rate_limits_updated_at = now_ms()
        self.rate_limits_error = None

    def snapshot(self):
        return {
            "workspace": self.workspace,
            "sessionName": self.session_name,
            "imageDir": str(self.image_dir),
            "authPath": str(self.codex_home / "auth.json"),
            "maxUploadMb": self.max_upload_bytes // 1024 // 1024,
            "imageCleanupSeconds": self.image_cleanup_seconds,
            "clipboardDisplay": self.clipboard_display,
            "fontSize": self.font_size,
            "version": self.version,
            "auth": self.auth_state,
            "authExists": (self.codex_home / "auth.json").exists(),
            "rateLimits": self.rate_limits,
            "rateLimitsSummary": self._rate_limits_summary(self.rate_limits),
            "rateLimitsUpdatedAt": self.rate_limits_updated_at,
            "rateLimitsError": self.rate_limits_error,
            "haAction": self.ha_action,
            "logs": list(self.logs.queue),
        }

    def upload_image(self, payload):
        data = payload.get("bytes")
        if data is None:
            raw_b64 = str(payload.get("data") or "")
            if "," in raw_b64 and raw_b64.lstrip().startswith("data:"):
                raw_b64 = raw_b64.split(",", 1)[1]
            try:
                data = base64.b64decode(raw_b64, validate=True)
            except Exception as exc:
                raise ValueError("Invalid image upload data") from exc
        if not isinstance(data, (bytes, bytearray)):
            raise ValueError("Invalid image upload data")
        data = bytes(data)
        mime = infer_image_type(data, payload.get("type"), payload.get("name"))
        if mime not in ALLOWED_IMAGE_TYPES:
            declared = normalize_image_type(payload.get("type"))
            detected = detect_image_type(data)
            raise ValueError(
                f"Unsupported image type: declared={declared or 'none'}, detected={detected or 'none'}, "
                f"name={payload.get('name') or 'unnamed'}"
            )
        if len(data) > self.max_upload_bytes:
            raise ValueError(f"Image exceeds {self.max_upload_bytes // 1024 // 1024} MB limit")
        filename = f"{int(time.time())}-{uuid.uuid4().hex[:10]}-{safe_filename(payload.get('name'))}{ALLOWED_IMAGE_TYPES[mime]}"
        path = self.image_dir / filename
        path.write_bytes(data)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        clipboard = self.push_image_to_clipboard(path, mime)
        return {
            "name": filename,
            "path": str(path),
            "shellPath": shlex.quote(str(path)),
            "size": len(data),
            "type": mime,
            "temporary": True,
            "cleanupAfterSeconds": self.image_cleanup_seconds or None,
            "clipboard": clipboard,
        }

    def schedule_uploaded_image_cleanup(self, payload):
        name = payload.get("name") or ""
        if "/" in name or "\\" in name:
            raise ValueError("Invalid image name")
        path = (self.image_dir / name).resolve()
        if path.parent != self.image_dir.resolve() or not path.exists():
            raise ValueError("Image not found")
        if self.image_cleanup_seconds:
            self.schedule_image_cleanup(path)
        return {"name": name, "cleanupAfterSeconds": self.image_cleanup_seconds}

    def push_image_to_clipboard(self, path, mime):
        if not self.clipboard_display:
            return {"ok": False, "error": "DISPLAY is unavailable"}
        if not shutil.which("xclip"):
            return {"ok": False, "error": "xclip is unavailable"}
        if not path.exists():
            return {"ok": False, "error": f"image file is unavailable: {path}"}

        env = os.environ.copy()
        env["DISPLAY"] = self.clipboard_display
        target = mime if mime in ALLOWED_IMAGE_TYPES else "image/png"
        try:
            proc = subprocess.Popen(
                ["xclip", "-selection", "clipboard", "-target", target, "-i", str(path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                env=env,
            )
            time.sleep(0.3)
            if proc.poll() is not None:
                stderr = ""
                if proc.stderr is not None:
                    stderr = proc.stderr.read(2048).decode("utf-8", errors="replace").strip()
                error = stderr or f"xclip exited before owning the clipboard (exit {proc.returncode})"
                return {"ok": False, "error": error, "target": target, "display": self.clipboard_display}
            threading.Thread(target=proc.wait, name="xclip-image", daemon=True).start()
            return {"ok": True, "target": target, "display": self.clipboard_display}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "target": target}

    def schedule_image_cleanup(self, path):
        def cleanup():
            try:
                path.unlink(missing_ok=True)
                self.add_log(f"deleted temporary image: {path}")
            except Exception as exc:
                self.add_log(f"failed to delete temporary image {path}: {exc}")

        timer = threading.Timer(self.image_cleanup_seconds, cleanup)
        timer.daemon = True
        timer.start()

    def upload_auth_json(self, payload):
        data = payload.get("bytes")
        if data is None:
            raw_b64 = str(payload.get("data") or "")
            if "," in raw_b64 and raw_b64.lstrip().startswith("data:"):
                raw_b64 = raw_b64.split(",", 1)[1]
            try:
                data = base64.b64decode(raw_b64, validate=True)
            except Exception as exc:
                raise ValueError("Invalid auth.json upload data") from exc
        if not isinstance(data, (bytes, bytearray)):
            raise ValueError("Invalid auth.json upload data")
        data = bytes(data)
        if len(data) > 1024 * 1024:
            raise ValueError("auth.json is unexpectedly large")
        try:
            parsed = json.loads(data.decode("utf-8-sig"))
        except Exception as exc:
            raise ValueError("Uploaded file is not valid JSON") from exc
        if not isinstance(parsed, dict):
            raise ValueError("auth.json must contain a JSON object")

        self.codex_home.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.codex_home, 0o700)
        except OSError:
            pass
        auth_path = self.codex_home / "auth.json"
        tmp_path = self.codex_home / ".auth.json.tmp"
        tmp_path.write_bytes(json.dumps(parsed, indent=2).encode("utf-8"))
        os.chmod(tmp_path, 0o600)
        tmp_path.replace(auth_path)
        self.codex.stop()
        restarted = self.restart_terminal_session()
        self.set_auth_state({"type": "authJson", "path": str(auth_path), "uploadedAt": now_ms(), "restarted": restarted})
        return {"path": str(auth_path), "bytes": len(data), "keys": sorted(parsed.keys()), "terminalRestarted": restarted}

    def restart_terminal_session(self):
        try:
            subprocess.run(
                ["tmux", "kill-session", "-t", self.session_name],
                env=os.environ.copy(),
                timeout=10,
                check=False,
            )
            return True
        except Exception as exc:
            self.add_log(f"failed to restart terminal session: {exc}")
            return False

    def read_rate_limits(self):
        try:
            self.codex.start()
            result = self.codex.request("account/rateLimits/read", timeout=30) or {}
            rate_limits = result.get("rateLimits") if isinstance(result, dict) else result
            self.set_rate_limits(rate_limits)
            return {
                "rateLimits": self.rate_limits,
                "summary": self._rate_limits_summary(self.rate_limits),
                "updatedAt": self.rate_limits_updated_at,
            }
        except Exception as exc:
            self.rate_limits_error = str(exc)
            return {"rateLimits": None, "summary": "Rate limit: unavailable", "error": str(exc), "updatedAt": now_ms()}

    def _rate_limits_summary(self, rate_limits):
        if not isinstance(rate_limits, dict):
            return "Rate limit: unavailable"
        parts = []
        name = rate_limits.get("limitName") or rate_limits.get("limitId")
        if name:
            parts.append(str(name))
        primary = rate_limits.get("primary") or {}
        secondary = rate_limits.get("secondary") or {}
        if isinstance(primary, dict) and primary.get("usedPercent") is not None:
            parts.append(f"{format_percent(primary.get('usedPercent'))} primary")
        if isinstance(secondary, dict) and secondary.get("usedPercent") is not None:
            parts.append(f"{format_percent(secondary.get('usedPercent'))} secondary")
        credits = rate_limits.get("credits") or {}
        if isinstance(credits, dict):
            if credits.get("unlimited"):
                parts.append("credits unlimited")
            elif credits.get("balance") is not None:
                parts.append(f"credits {credits.get('balance')}")
        if rate_limits.get("rateLimitReachedType"):
            parts.append(str(rate_limits.get("rateLimitReachedType")))
        return "Rate limit: " + (" | ".join(parts) if parts else "available")

    def home_assistant_action(self, action):
        token = os.environ.get("SUPERVISOR_TOKEN")
        if not token:
            raise ValueError("SUPERVISOR_TOKEN is unavailable; rebuild the add-on with Home Assistant API access enabled")
        if action == "reload_yaml":
            url = "http://supervisor/core/api/services/homeassistant/reload_all"
            body = b"{}"
        elif action == "restart":
            url = "http://supervisor/core/restart"
            body = b"{}"
        else:
            raise ValueError("Unknown Home Assistant action")
        request = Request(
            url,
            data=body,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=20) as response:
                response_body = response.read(2048).decode("utf-8", errors="replace")
                result = {"status": response.status, "body": response_body}
        except HTTPError as exc:
            response_body = exc.read(2048).decode("utf-8", errors="replace")
            raise ValueError(f"Home Assistant API returned HTTP {exc.code}: {response_body}") from exc
        except URLError as exc:
            raise ValueError(f"Home Assistant API request failed: {exc}") from exc
        self.ha_action = {"action": action, "time": now_ms(), "result": result}
        return result

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
                elif path == "/icon.png":
                    self._serve_file(app.web_dir / "icon.png", "image/png")
                elif path == "/favicon.ico":
                    self._serve_file(app.web_dir / "favicon.ico", "image/x-icon")
                elif path == "/vendor/xterm.css":
                    self._serve_file(app.vendor_dir / "xterm.css", "text/css; charset=utf-8")
                elif path == "/vendor/xterm.js":
                    self._serve_file(app.vendor_dir / "xterm.js", "application/javascript; charset=utf-8")
                elif path == "/vendor/xterm-addon-fit.js":
                    self._serve_file(app.vendor_dir / "xterm-addon-fit.js", "application/javascript; charset=utf-8")
                elif path.startswith("/vendor/fontawesome/"):
                    self._serve_vendor_asset(path.removeprefix("/vendor/fontawesome/"))
                elif path == "/api/state":
                    self._json(app.snapshot())
                elif path == "/api/rate-limits":
                    self._json({"ok": True, "result": app.read_rate_limits()})
                elif path.startswith("/api/image/"):
                    self._serve_image(path.removeprefix("/api/image/"))
                elif path == "/ws":
                    app.handle_terminal_ws(self)
                else:
                    self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

            def do_POST(self):
                parsed = urlparse(self.path)
                try:
                    if parsed.path == "/api/upload":
                        payload = self._read_upload()
                        self._json({"ok": True, "image": app.upload_image(payload)})
                    else:
                        if parsed.path == "/api/auth/upload":
                            payload = self._read_upload()
                            self._json({"ok": True, "result": app.upload_auth_json(payload)})
                        else:
                            payload = self._read_json()
                            if parsed.path == "/api/image/cleanup":
                                self._json({"ok": True, "result": app.schedule_uploaded_image_cleanup(payload)})
                            elif parsed.path == "/api/ha/reload-yaml":
                                self._json({"ok": True, "result": app.home_assistant_action("reload_yaml")})
                            elif parsed.path == "/api/ha/restart":
                                self._json({"ok": True, "result": app.home_assistant_action("restart")})
                            else:
                                self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
                except Exception as exc:
                    app.add_log(f"request failed: {exc}")
                    self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

            def _read_upload(self):
                content_type = self.headers.get("Content-Type", "")
                if not content_type.lower().startswith("multipart/form-data"):
                    return self._read_json()
                length = int(self.headers.get("Content-Length", "0"))
                if length > app.max_upload_bytes + 1024 * 1024:
                    raise ValueError("Request body is too large")
                form = cgi.FieldStorage(
                    fp=self.rfile,
                    headers=self.headers,
                    environ={
                        "REQUEST_METHOD": "POST",
                        "CONTENT_TYPE": content_type,
                        "CONTENT_LENGTH": str(length),
                    },
                )
                item = form["file"] if "file" in form else None
                if isinstance(item, list):
                    item = item[0] if item else None
                if item is None or not getattr(item, "file", None):
                    raise ValueError("Missing image upload file")
                data = item.file.read()
                if len(data) > app.max_upload_bytes:
                    raise ValueError(f"Image exceeds {app.max_upload_bytes // 1024 // 1024} MB limit")
                return {
                    "bytes": data,
                    "name": item.filename or form.getfirst("name") or "pasted-image",
                    "type": getattr(item, "type", None) or form.getfirst("type") or "",
                }

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

            def _serve_vendor_asset(self, encoded_name):
                name = unquote(encoded_name)
                if name.startswith("/") or "\\" in name or ".." in Path(name).parts:
                    self._json({"error": "Invalid vendor path"}, HTTPStatus.BAD_REQUEST)
                    return
                path = (app.vendor_dir / "fontawesome" / name).resolve()
                root = (app.vendor_dir / "fontawesome").resolve()
                try:
                    if root not in path.parents or not path.exists() or not path.is_file():
                        self._json({"error": "Vendor asset not found"}, HTTPStatus.NOT_FOUND)
                        return
                except OSError:
                    self._json({"error": "Vendor asset not found"}, HTTPStatus.NOT_FOUND)
                    return
                content_type = "application/octet-stream"
                if path.suffix == ".css":
                    content_type = "text/css; charset=utf-8"
                elif path.suffix == ".woff2":
                    content_type = "font/woff2"
                elif path.suffix == ".ttf":
                    content_type = "font/ttf"
                self._serve_file(path, content_type)

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
                    ".avif": "image/avif",
                    ".bmp": "image/bmp",
                    ".gif": "image/gif",
                    ".heic": "image/heic",
                    ".heif": "image/heif",
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".png": "image/png",
                    ".tif": "image/tiff",
                    ".tiff": "image/tiff",
                    ".webp": "image/webp",
                }.get(path.suffix.lower(), "application/octet-stream")
                self._serve_file(path, content_type)

        return Handler


if __name__ == "__main__":
    App().serve()
