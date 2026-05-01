import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


SERVER_PATH = Path(__file__).resolve().parents[1] / "codex-cli" / "scripts" / "server.py"
SPEC = importlib.util.spec_from_file_location("codex_cli_ha_server", SERVER_PATH)
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class FakeCodex:
    def __init__(self):
        self.started = 0
        self.requests = []

    def start(self):
        self.started += 1

    def request(self, method, params=None, timeout=None):
        self.requests.append((method, params, timeout))
        if method == "account/login/start" and params["type"] == "chatgpt":
            return {"type": "chatgpt", "loginId": "login-1", "authUrl": "https://auth.example/start"}
        if method == "account/login/start" and params["type"] == "chatgptDeviceCode":
            return {
                "type": "chatgptDeviceCode",
                "loginId": "login-2",
                "verificationUrl": "https://auth.example/device",
                "userCode": "ABCD-EFGH",
            }
        if method == "account/login/cancel":
            return {"status": "canceled"}
        if method == "account/read":
            return {"account": {"type": "chatgpt", "email": "user@example.com"}, "requiresOpenaiAuth": False}
        raise AssertionError(f"Unexpected request: {method}")


class ServerSecurityTests(unittest.TestCase):
    def test_child_env_strips_supervisor_tokens(self):
        old_environ = os.environ.copy()
        try:
            os.environ["SUPERVISOR_TOKEN"] = "secret"
            os.environ["HASSIO_TOKEN"] = "secret"
            env = server.child_env({"DISPLAY": ":99"})
        finally:
            os.environ.clear()
            os.environ.update(old_environ)

        self.assertNotIn("SUPERVISOR_TOKEN", env)
        self.assertNotIn("HASSIO_TOKEN", env)
        self.assertEqual(env["DISPLAY"], ":99")

    def test_default_client_allowlist_keeps_ingress_and_loopback_only(self):
        allowed = server.parse_allowed_clients(None)

        self.assertTrue(server.client_is_allowed("127.0.0.1", allowed))
        self.assertTrue(server.client_is_allowed("::1", allowed))
        self.assertTrue(server.client_is_allowed("172.30.32.2", allowed))
        self.assertFalse(server.client_is_allowed("172.30.32.1", allowed))
        self.assertFalse(server.client_is_allowed("192.168.1.20", allowed))

    def test_allowlist_supports_cidr_without_opening_everything(self):
        allowed = server.parse_allowed_clients("10.0.0.0/24")

        self.assertTrue(server.client_is_allowed("10.0.0.42", allowed))
        self.assertFalse(server.client_is_allowed("10.0.1.42", allowed))


class AccountLoginTests(unittest.TestCase):
    def make_app(self):
        old_environ = os.environ.copy()
        temp_dir = tempfile.TemporaryDirectory()
        os.environ["CODEX_IMAGE_DIR"] = str(Path(temp_dir.name) / "images")
        os.environ["CODEX_HOME"] = str(Path(temp_dir.name) / "codex-home")
        os.environ["CODEX_WORKSPACE"] = temp_dir.name
        app = server.App()
        app.codex = FakeCodex()
        self.addCleanup(temp_dir.cleanup)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(old_environ)))
        return app

    def test_browser_login_uses_current_codex_oauth_flow(self):
        app = self.make_app()

        state = app.start_account_login({"type": "chatgpt"})

        self.assertEqual(state["type"], "login")
        self.assertEqual(state["status"], "pending")
        self.assertEqual(state["loginType"], "chatgpt")
        self.assertEqual(state["authUrl"], "https://auth.example/start")
        self.assertEqual(
            app.codex.requests[-1],
            ("account/login/start", {"type": "chatgpt", "codexStreamlinedLogin": True}, 30),
        )

    def test_device_code_login_returns_verification_details(self):
        app = self.make_app()

        state = app.start_account_login({"type": "chatgptDeviceCode"})

        self.assertEqual(state["loginType"], "chatgptDeviceCode")
        self.assertEqual(state["verificationUrl"], "https://auth.example/device")
        self.assertEqual(state["userCode"], "ABCD-EFGH")

    def test_new_login_cancels_pending_login(self):
        app = self.make_app()
        app.auth_state = {"type": "login", "status": "pending", "loginId": "stale-login"}

        app.start_account_login({"type": "chatgpt"})

        self.assertIn(("account/login/cancel", {"loginId": "stale-login"}, 5), app.codex.requests)


if __name__ == "__main__":
    unittest.main()
