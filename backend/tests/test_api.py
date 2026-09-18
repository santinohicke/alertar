import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path

from app import ROOT, create_app, utcnow


class ApiTests(unittest.TestCase):
    def setUp(self):
        directory = ROOT / ".test-tmp"
        directory.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=directory)
        self.database = str(Path(self.temp.name) / "test.sqlite3")
        self.app = create_app({"TESTING": True, "DATABASE": self.database})
        self.client = self.app.test_client()
        self.event = json.loads((ROOT / "examples" / "evento.json").read_text())

    def tearDown(self):
        self.temp.cleanup()

    def post(self, **changes):
        return self.client.post("/api/eventos", json={**self.event, **changes})

    def test_receive_query_and_persist_after_restart(self):
        self.assertEqual(self.post().status_code, 201)
        client = create_app({"TESTING": True, "DATABASE": self.database}).test_client()
        self.assertEqual(client.get("/health").json["estado"], "ok")
        self.assertEqual(client.get("/api/pasos/tunel-01/historial").json["total"], 1)
        self.assertEqual(client.get("/api/pasos/tunel-01/estado").json["actualidad_medicion"], "desconocida")

    def test_duplicate_and_conflicts(self):
        first = self.post()
        second = self.post()
        self.assertEqual(second.status_code, 200)
        self.assertTrue(second.json["duplicado"])
        self.assertEqual(first.json["recibido_en"], second.json["recibido_en"])
        self.assertEqual(self.post(diagnostico="Modificado").status_code, 409)
        self.assertEqual(self.post(evento_id="otra-identidad").status_code, 409)
        self.assertEqual(self.client.get("/api/pasos/tunel-01/historial").json["total"], 1)

    def test_old_event_does_not_replace_state(self):
        self.post(secuencia=20, evento_id="evento-20", codigo="ERR-001", agua_activa=True)
        self.post()
        state = self.client.get("/api/pasos/tunel-01/estado").json
        self.assertEqual(state["ultimo_estado_conocido"]["codigo"], "ERR-001")

    def test_freshness_distinguishes_backlog(self):
        self.post(medido_en=(utcnow() - timedelta(hours=1)).isoformat())
        state = self.client.get("/api/pasos/tunel-01/estado").json
        self.assertEqual(state["actualidad_medicion"], "desactualizada")
        self.assertEqual(state["comunicacion"], "recepcion_reciente")
        with closing(sqlite3.connect(self.database)) as connection:
            with connection:
                connection.execute("UPDATE eventos SET recibido_en = ?", ((utcnow() - timedelta(minutes=2)).isoformat(),))
        self.assertEqual(self.client.get("/api/pasos/tunel-01/estado").json["comunicacion"], "sin_comunicacion")

    def test_recent_measurement(self):
        self.post(medido_en=utcnow().isoformat())
        self.assertEqual(self.client.get("/api/pasos/tunel-01/estado").json["actualidad_medicion"], "reciente")

    def test_invalid_data(self):
        cases = [dict(version=True), dict(secuencia=True), dict(secuencia=-1),
                 dict(secuencia=2**63), dict(sensor1_valido="true"),
                 dict(obstruccion_carril1_cm=float("nan")),
                 dict(obstruccion_carril1_cm=399), dict(obstruccion_carril1_cm=None),
                 dict(sensor1_valido=False), dict(codigo=[]), dict(codigo="ERR-999"),
                 dict(agua_activa=True, agua_pendiente=True), dict(diagnostico=""),
                 dict(medido_en="2026-01-01"), dict(medido_en="no-fecha"),
                 dict(medido_en=(utcnow() + timedelta(hours=1)).isoformat()),
                 dict(dispositivo_id="otro"), dict(paso_id="otro"), dict(extra=1)]
        for changes in cases:
            with self.subTest(changes=changes):
                self.assertEqual(self.post(**changes).status_code, 400)
        for body in ({}, [], None):
            self.assertEqual(self.client.post("/api/eventos", data=json.dumps(body), content_type="application/json").status_code, 400)
        self.assertEqual(self.client.get("/api/pasos/tunel-01/historial").json["total"], 0)

    def test_invalid_sensor_null_is_accepted(self):
        self.assertEqual(self.post(sensor1_valido=False, obstruccion_carril1_cm=None, codigo="ERR-003").status_code, 201)

    def test_http_errors(self):
        self.assertEqual(self.client.post("/api/eventos", data="bad").status_code, 415)
        self.assertEqual(self.client.post("/api/eventos", data="{", content_type="application/json").status_code, 400)
        self.assertEqual(self.client.post("/api/eventos", data="x" * 17000, content_type="application/json").status_code, 413)
        self.assertEqual(self.client.get("/api/pasos/ausente/estado").status_code, 404)
        self.assertEqual(self.client.get("/api/pasos/ausente/historial").json["total"], 0)

    def test_history_pagination(self):
        for seq in range(3):
            self.post(evento_id=f"event-{seq}", secuencia=seq)
        result = self.client.get("/api/pasos/tunel-01/historial?limite=1&offset=1").json
        self.assertEqual(result["total"], 3)
        self.assertEqual(result["eventos"][0]["secuencia"], 1)
        for query in ("limite=0", "limite=201", "offset=-1", "limite=abc"):
            self.assertEqual(self.client.get(f"/api/pasos/tunel-01/historial?{query}").status_code, 400)

    def test_concurrent_retries_insert_once(self):
        def send(_):
            with self.app.test_client() as client:
                return client.post("/api/eventos", json=self.event).status_code
        with ThreadPoolExecutor(max_workers=4) as pool:
            statuses = list(pool.map(send, range(8)))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(200), 7)

    def test_database_failure_does_not_acknowledge(self):
        with closing(sqlite3.connect(self.database)) as connection:
            with connection:
                connection.execute("DROP TABLE eventos")
        with self.assertLogs(self.app.logger, level="ERROR"):
            response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("guardado", response.json)


if __name__ == "__main__":
    unittest.main()
