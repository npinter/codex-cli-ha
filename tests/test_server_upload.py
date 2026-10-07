import importlib.util
from http import HTTPStatus
from io import BytesIO
from pathlib import Path
import unittest


SERVER_PATH = Path(__file__).resolve().parents[1] / "codex-cli" / "scripts" / "server.py"
spec = importlib.util.spec_from_file_location("codex_cli_ha_server", SERVER_PATH)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

BOUNDARY = "codex-cli-ha-test-boundary"
CONTENT_TYPE = f"multipart/form-data; boundary={BOUNDARY}"


def multipart(parts):
    body = bytearray()
    for name, filename, mime, data in parts:
        body.extend(f"--{BOUNDARY}\r\n".encode())
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if filename is not None:
            disposition += f'; filename="{filename}"'
        body.extend(f"{disposition}\r\n".encode())
        if mime is not None:
            body.extend(f"Content-Type: {mime}\r\n".encode())
        body.extend(b"\r\n")
        body.extend(data)
        body.extend(b"\r\n")
    body.extend(f"--{BOUNDARY}--\r\n".encode())
    return bytes(body)


def chunked(data):
    middle = len(data) // 2
    chunks = (data[:middle], data[middle:])
    return b"".join(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n" for chunk in chunks) + b"0\r\n\r\n"


class MultipartUploadTests(unittest.TestCase):
    def test_image_bytes_and_metadata_survive_browser_form(self):
        image = b"\x89PNG\r\n\x1a\n\x00\xff\x80\r\n--codex-cli-ha-test-boundaryx"
        body = multipart(
            [
                ("file", "camera.png", "image/png", image),
                ("name", None, None, b"fallback.png"),
                ("type", None, None, b"image/jpeg"),
            ]
        )

        upload = server.parse_multipart_upload(CONTENT_TYPE, body, 1024)

        self.assertEqual(upload, {"bytes": image, "name": "camera.png", "type": "image/png"})

    def test_upload_uses_body_delimiter_when_header_boundary_is_missing_or_rewritten(self):
        image = b"\x89PNG\r\n\x1a\n"
        body = multipart([("file", "camera.png", "image/png", image)])

        for content_type in ("multipart/form-data", "multipart/form-data; boundary=wrong"):
            with self.subTest(content_type=content_type):
                upload = server.parse_multipart_upload(content_type, body, 1024)
                self.assertEqual(upload["bytes"], image)

    def test_http_upload_handler_accepts_body_when_boundary_header_is_missing(self):
        image = b"\x89PNG\r\n\x1a\n"
        body = multipart([("file", "camera.png", "image/png", image)])
        app = object.__new__(server.App)
        app.max_upload_bytes = 1024
        handler = object.__new__(app._handler())
        handler.headers = {
            "Content-Type": "multipart/form-data",
            "Content-Length": str(len(body)),
        }
        handler.rfile = BytesIO(body)

        upload = handler._read_upload()

        self.assertEqual(upload, {"bytes": image, "name": "camera.png", "type": "image/png"})

    def test_http_upload_handler_accepts_chunked_multipart_body(self):
        image = b"\x89PNG\r\n\x1a\n"
        body = multipart([("file", "camera.png", "image/png", image)])
        app = object.__new__(server.App)
        app.max_upload_bytes = 1024
        handler = object.__new__(app._handler())
        handler.headers = {
            "Content-Type": CONTENT_TYPE,
            "Transfer-Encoding": "chunked",
        }
        handler.rfile = BytesIO(chunked(body))

        upload = handler._read_upload()

        self.assertEqual(upload["bytes"], image)

    def test_auth_json_upload_keeps_file_contents(self):
        auth = b'{"tokens":{"access_token":"test"}}'
        body = multipart(
            [
                ("name", None, None, b"auth.json"),
                ("file", "auth.json", "application/json", auth),
            ]
        )

        upload = server.parse_multipart_upload(CONTENT_TYPE, body, 1024)

        self.assertEqual(upload, {"bytes": auth, "name": "auth.json", "type": "application/json"})

    def test_field_metadata_is_used_when_file_headers_omit_it(self):
        body = multipart(
            [
                ("file", None, None, b"image bytes"),
                ("name", None, None, b"phone.png"),
                ("type", None, None, b"image/png"),
            ]
        )

        upload = server.parse_multipart_upload(CONTENT_TYPE, body, 1024)

        self.assertEqual(upload["name"], "phone.png")
        self.assertEqual(upload["type"], "image/png")

    def test_missing_or_oversized_file_is_rejected(self):
        missing = multipart([("name", None, None, b"camera.png")])
        with self.assertRaisesRegex(ValueError, "Missing image upload file"):
            server.parse_multipart_upload(CONTENT_TYPE, missing, 1024)

        oversized = multipart([("file", "camera.png", "image/png", b"abcd")])
        with self.assertRaisesRegex(ValueError, "Image exceeds"):
            server.parse_multipart_upload(CONTENT_TYPE, oversized, 3)

        with self.assertRaisesRegex(ValueError, "Invalid multipart upload"):
            server.parse_multipart_upload(CONTENT_TYPE, b"not a multipart body", 1024)


class RawUploadTests(unittest.TestCase):
    def test_raw_image_and_auth_routes_receive_exact_file_bytes(self):
        image = b"\x89PNG\r\n\x1a\n\x00\xff"
        auth = b'{"tokens":{"access_token":"test"}}'
        app = object.__new__(server.App)
        app.max_upload_bytes = 1024
        app.add_log = lambda line: self.fail(line)
        received = []
        app.upload_image = lambda payload: received.append(("image", payload)) or {"accepted": True}
        app.upload_auth_json = lambda payload: received.append(("auth", payload)) or {"accepted": True}

        for path, data in (
            ("/api/upload/raw?name=front%20door.png&type=image%2Fpng", image),
            ("/api/auth/upload/raw?name=auth.json", auth),
        ):
            with self.subTest(path=path):
                handler = object.__new__(app._handler())
                handler.path = path
                handler.headers = {"Content-Length": str(len(data)), "Content-Type": "application/octet-stream"}
                handler.rfile = BytesIO(data)
                responses = []
                handler._json = lambda payload, status=HTTPStatus.OK: responses.append((status, payload))
                handler.do_POST()
                self.assertEqual(responses, [(HTTPStatus.OK, {"ok": True, "image" if path.startswith("/api/upload") else "result": {"accepted": True}})])

        self.assertEqual(received[0], ("image", {"bytes": image, "name": "front door.png", "type": "image/png"}))
        self.assertEqual(received[1], ("auth", {"bytes": auth, "name": "auth.json", "type": ""}))

    def test_raw_upload_rejects_oversized_and_incomplete_bodies(self):
        app = object.__new__(server.App)
        handler = object.__new__(app._handler())
        handler.headers = {"Content-Length": "4"}
        handler.rfile = BytesIO(b"abcd")
        with self.assertRaisesRegex(ValueError, "too large"):
            handler._read_raw_upload("", 3)

        handler.rfile = BytesIO(b"ab")
        with self.assertRaisesRegex(ValueError, "Incomplete file upload"):
            handler._read_raw_upload("", 4)

    def test_raw_upload_accepts_chunked_body_without_content_length(self):
        auth = b'{"tokens":{"access_token":"test"}}'
        app = object.__new__(server.App)
        handler = object.__new__(app._handler())
        handler.headers = {"Transfer-Encoding": "chunked"}
        handler.rfile = BytesIO(chunked(auth))

        upload = handler._read_raw_upload("name=auth.json", 1024)

        self.assertEqual(upload, {"bytes": auth, "name": "auth.json", "type": ""})

    def test_chunked_bodies_obey_size_and_framing_limits(self):
        app = object.__new__(server.App)
        handler = object.__new__(app._handler())
        handler.headers = {"Transfer-Encoding": "chunked"}
        handler.rfile = BytesIO(chunked(b"abcd"))
        with self.assertRaisesRegex(ValueError, "too large"):
            handler._read_raw_upload("", 3)

        handler.headers["Content-Length"] = "4"
        handler.rfile = BytesIO(chunked(b"abcd"))
        with self.assertRaisesRegex(ValueError, "Unsupported request body framing"):
            handler._read_raw_upload("", 1024)

    def test_json_fallback_accepts_chunked_body(self):
        app = object.__new__(server.App)
        app.max_upload_bytes = 1024
        handler = object.__new__(app._handler())
        handler.headers = {"Transfer-Encoding": "chunked"}
        handler.rfile = BytesIO(chunked(b'{"data":"test"}'))

        self.assertEqual(handler._read_json(), {"data": "test"})


if __name__ == "__main__":
    unittest.main()
