import json
import re
import tempfile
import unittest
from pathlib import Path

from app import ROOT, create_app
from panel import Cubo


class PanelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT / ".test-tmp")
        self.config = dict(TESTING=True, DATABASE=str(Path(self.tmp.name) / "panel.db"),
                           REQUIRE_AUTH=True, API_KEY="master-" + "a" * 32,
                           DEVICE_KEY="device-" + "b" * 32, RATE_LIMIT_ENABLED=False,
                           SESSION_COOKIE_SECURE=True)
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.event = json.loads((ROOT / "examples/evento.json").read_text())

    def tearDown(self):
        self.tmp.cleanup()

    def headers(self, device=False):
        return {"X-API-Key": self.config["DEVICE_KEY" if device else "API_KEY"]}

    def login(self):
        page = self.client.get("/login")
        token = re.search(r'name="csrf" value="([^"]+)"', page.text).group(1)
        return self.client.post("/login", data={"csrf": token, "clave": self.config["API_KEY"]})

    def test_closed_by_default_when_published(self):
        self.assertEqual(self.client.get("/").status_code, 302)
        self.assertEqual(self.client.get("/api/panel/tunel-01").status_code, 401)
        self.assertEqual(self.client.post("/api/eventos", json=self.event).status_code, 401)
        with self.assertRaises(RuntimeError):
            create_app({**self.config, "API_KEY": ""})

    def test_device_key_can_only_ingest(self):
        self.assertEqual(self.client.post("/api/eventos", json=self.event, headers=self.headers(True)).status_code, 201)
        self.assertEqual(self.client.post("/api/dispositivos/esp32-01/reserva", json={"instalacion_id":"f"*32}, headers=self.headers(True)).status_code, 201)
        self.assertEqual(self.client.get("/api/panel/tunel-01", headers=self.headers(True)).status_code, 401)

    def test_login_csrf_cookie_and_read_only_session(self):
        self.assertEqual(self.client.post("/login", data={"clave":self.config["API_KEY"]}).status_code, 400)
        response = self.login()
        self.assertEqual(response.status_code, 302)
        cookie = response.headers["Set-Cookie"]
        for value in ("Secure", "HttpOnly", "SameSite=Strict"):
            self.assertIn(value, cookie)
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/api/panel/tunel-01").status_code, 200)
        self.assertEqual(self.client.post("/api/eventos", json=self.event).status_code, 401)
        self.assertNotIn(self.config["API_KEY"], self.client.get("/").text)

    def test_panel_bounded_and_preserves_unknown_freshness(self):
        for seq in range(25):
            self.client.post("/api/eventos", json={**self.event,"evento_id":f"panel-{seq}","secuencia":seq}, headers=self.headers())
        result = self.client.get("/api/panel/tunel-01", headers=self.headers()).json
        self.assertEqual(len(result["eventos"]), 20)
        self.assertEqual(result["vigencia_s"], 60)
        self.assertEqual(result["eventos"][0]["secuencia"], 24)
        self.assertEqual(result["estado"]["actualidad_medicion"], "desconocida")
        self.assertEqual(self.client.get("/api/panel/otro", headers=self.headers()).status_code, 404)

    def test_rate_limit_and_recovery_without_sleep(self):
        app = create_app({**self.config, "RATE_LIMIT_ENABLED":True})
        now = [0.0]
        app.extensions["alertar_cubos"]["ingesta"] = Cubo(2, 4, lambda:now[0])
        client = app.test_client()
        for _ in range(4):
            self.assertIn(client.post("/api/eventos", json=self.event, headers=self.headers()).status_code, (200,201))
        response = client.post("/api/eventos", json=self.event, headers=self.headers())
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["Retry-After"], "5")
        now[0] += 5
        self.assertEqual(client.post("/api/eventos", json=self.event, headers=self.headers()).status_code, 200)

    def test_security_headers_and_injection_is_data(self):
        self.client.post("/api/eventos", json={**self.event,"diagnostico":"<script>alert(1)</script>"}, headers=self.headers())
        response = self.client.get("/api/panel/tunel-01", headers=self.headers())
        self.assertEqual(response.content_type, "application/json")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
        script = (ROOT / "static/panel.js").read_text(encoding="utf-8")
        self.assertNotIn("innerHTML", script)


if __name__ == "__main__":
    unittest.main()
