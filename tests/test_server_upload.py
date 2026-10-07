import importlib.util
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


if __name__ == "__main__":
    unittest.main()
