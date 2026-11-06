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

class TunelesTests(PanelTests):
    def crear(self, **extra):
        return self.client.post("/api/tuneles", headers=self.headers(),
                                json={"nombre": "Paso Norte", "ubicacion": "Km 12",
                                      "latitud": -34.6, "longitud": -58.38, **extra})

    def evento(self, paso, dispositivo, **cambios):
        return {**self.event, "paso_id": paso, "dispositivo_id": dispositivo,
                "evento_id": "e-" + dispositivo, **cambios}

    def test_key_bound_to_location_and_tunnel(self):
        r = self.crear()
        self.assertEqual(r.status_code, 201)
        datos = r.json
        self.assertEqual((datos["latitud"], datos["ubicacion"]), (-34.6, "Km 12"))
        key = {"X-API-Key": datos["api_key"]}
        ok = self.client.post("/api/eventos", headers=key, json=self.evento(datos["paso_id"], datos["dispositivo_id"]))
        self.assertEqual(ok.status_code, 201)
        ajeno = self.client.post("/api/eventos", headers=key, json=self.evento("tunel-01", "esp32-01"))
        self.assertEqual(ajeno.status_code, 403)

    def test_batch_uses_device_key_per_event(self):
        datos = self.crear().json
        key = {"X-API-Key": datos["api_key"]}
        propio = self.evento(datos["paso_id"], datos["dispositivo_id"])
        ajeno = self.evento("tunel-01", "esp32-01")
        r = self.client.post("/api/eventos/lote", headers=key, json={"eventos": [propio, ajeno]})
        self.assertEqual([x["estado"] for x in r.json["resultados"]], [201, 403])
        sin_clave = self.client.post("/api/eventos/lote", json={"eventos": [propio]})
        self.assertEqual(sin_clave.status_code, 401)

    def test_keys_stored_hashed_and_never_listed(self):
        clave = self.crear().json["api_key"]
        import sqlite3
        with sqlite3.connect(self.config["DATABASE"]) as con:
            guardadas = [f[0] for f in con.execute("SELECT api_key FROM tuneles")]
        self.assertTrue(all(g.startswith("sha256:") for g in guardadas))
        self.assertNotIn(clave, guardadas)
        listado = self.client.get("/api/tuneles", headers=self.headers())
        self.assertNotIn(clave, listado.text)
        self.assertNotIn("api_key", listado.json["tuneles"][0])

    # SOLO PARA LA DEMO: la clave se guarda también para mostrarla en el panel (DEMO_GUARDAR_CLAVES).
    def test_demo_key_readable_only_from_panel(self):
        d = self.crear().json
        url = f"/api/tuneles/{d['paso_id']}/clave"
        self.assertEqual(self.client.get(url, headers=self.headers()).json["clave"], d["api_key"])
        self.assertEqual(self.client.get(url).status_code, 401)
        self.assertEqual(self.client.get(url, headers={"X-API-Key": d["api_key"]}).status_code, 401)
        self.assertEqual(self.client.get(url, headers=self.headers(device=True)).status_code, 401)
        nueva = self.client.post(url, headers=self.headers()).json["api_key"]
        self.assertEqual(self.client.get(url, headers=self.headers()).json["clave"], nueva)
        self.assertEqual(self.client.get("/api/tuneles/no-existe/clave", headers=self.headers()).status_code, 404)

    def test_demo_key_storage_can_be_disabled(self):
        self.app = create_app({**self.config, "DEMO_GUARDAR_CLAVES": False})
        self.client = self.app.test_client()
        d = self.crear().json
        self.assertEqual(self.client.get(f"/api/tuneles/{d['paso_id']}/clave", headers=self.headers()).status_code, 404)
        import sqlite3
        with sqlite3.connect(self.config["DATABASE"]) as con:
            self.assertEqual(con.execute("SELECT clave_demo FROM tuneles WHERE paso_id=?", (d["paso_id"],)).fetchone()[0], None)

    def test_panel_session_deletes_with_csrf_only(self):
        d = self.crear().json
        self.login()
        pagina = self.client.get("/").text
        token = re.search(r'name="csrf" value="([^"]+)"', pagina).group(1)
        self.assertEqual(self.client.delete(f"/api/tuneles/{d['paso_id']}").status_code, 403)
        self.assertEqual(self.client.delete(f"/api/tuneles/{d['paso_id']}", headers={"X-CSRF-Token": token}).status_code, 200)
        self.assertEqual(self.client.get(f"/api/pasos/{d['paso_id']}/estadisticas").status_code, 404)

    def test_rotating_tunel01_revokes_initial_device_key(self):
        # ALERTAR_DEVICE_KEY es solo la clave inicial de tunel-01: después de regenerarla deja de valer.
        ingesta = lambda k: self.client.post("/api/eventos", json=self.event, headers={"X-API-Key": k})
        self.assertEqual(ingesta(self.config["DEVICE_KEY"]).status_code, 201)
        nueva = self.client.post("/api/tuneles/tunel-01/clave", headers=self.headers()).json["api_key"]
        self.assertEqual(ingesta(self.config["DEVICE_KEY"]).status_code, 401)
        self.assertEqual(ingesta(nueva).status_code, 200)  # mismo evento: duplicado aceptado con la clave nueva

    def test_rotate_key_invalidates_old(self):
        d = self.crear().json
        nueva = self.client.post(f"/api/tuneles/{d['paso_id']}/clave", headers=self.headers()).json["api_key"]
        ev = self.evento(d["paso_id"], d["dispositivo_id"])
        self.assertEqual(self.client.post("/api/eventos", headers={"X-API-Key": d["api_key"]}, json=ev).status_code, 401)
        self.assertEqual(self.client.post("/api/eventos", headers={"X-API-Key": nueva}, json=ev).status_code, 201)

    def test_edit_location_and_validation(self):
        d = self.crear().json
        r = self.client.patch(f"/api/tuneles/{d['paso_id']}", headers=self.headers(),
                              json={"latitud": -31.4, "longitud": -64.2, "ubicacion": "Córdoba"})
        self.assertEqual((r.status_code, r.json["longitud"]), (200, -64.2))
        for malo in ({"latitud": 91, "longitud": 0}, {"latitud": 1, "longitud": None}, {"latitud": "x", "longitud": 1}):
            self.assertEqual(self.crear(**malo).status_code, 400)

    def test_delete_removes_events_and_protects_base(self):
        d = self.crear().json
        self.client.post("/api/eventos", headers={"X-API-Key": d["api_key"]},
                         json=self.evento(d["paso_id"], d["dispositivo_id"]))
        self.assertEqual(self.client.delete("/api/tuneles/tunel-01", headers=self.headers()).status_code, 400)
        self.assertEqual(self.client.delete(f"/api/tuneles/{d['paso_id']}", headers=self.headers()).status_code, 200)
        import sqlite3
        with sqlite3.connect(self.config["DATABASE"]) as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM eventos WHERE paso_id=?", (d["paso_id"],)).fetchone()[0], 0)

    def test_device_key_cannot_admin_and_session_needs_csrf(self):
        self.assertEqual(self.client.post("/api/tuneles", headers=self.headers(device=True), json={"nombre": "x"}).status_code, 401)
        self.login()
        self.assertEqual(self.client.post("/api/tuneles", json={"nombre": "x"}).status_code, 403)
        token = re.search(r'name="csrf"\s+value="([^"]+)"', self.client.get("/").text).group(1)
        r = self.client.post("/api/tuneles", headers={"X-CSRF-Token": token}, json={"nombre": "x"})
        self.assertEqual(r.status_code, 201)

    def test_simulator_disabled_by_default(self):
        r = self.client.post("/api/simulador/evento", headers=self.headers(), json={"tipo": "agua"})
        self.assertEqual(r.status_code, 404)
        app = create_app({**self.config, "DATABASE": self.config["DATABASE"] + "2", "ENABLE_SIMULATOR": True})
        r = app.test_client().post("/api/simulador/evento", headers=self.headers(), json={"tipo": "agua"})
        self.assertEqual(r.status_code, 201)

    def test_no_default_device_key(self):
        import sqlite3
        with sqlite3.connect(self.config["DATABASE"]) as con:
            fila = con.execute("SELECT api_key FROM tuneles").fetchone()[0]
        self.assertTrue(fila.startswith("sha256:"))

