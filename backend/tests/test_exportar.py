import csv
import io
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import ROOT, create_app


class ExportarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT / ".test-tmp")
        self.config = dict(TESTING=True, DATABASE=str(Path(self.tmp.name) / "e.db"), REQUIRE_AUTH=True,
                           API_KEY="master-" + "a" * 32, DEVICE_KEY="device-" + "b" * 32,
                           RATE_LIMIT_ENABLED=False, SESSION_COOKIE_SECURE=True)
        self.client = create_app(self.config).test_client()
        base = json.loads((ROOT / "examples/evento.json").read_text())
        self.ahora = datetime.now(timezone.utc).replace(microsecond=0)
        # 450 eventos, uno por minuto hacia atrás: más que el máximo de una página del historial.
        for i in range(450):
            ev = {**base, "evento_id": f"e-{i}", "secuencia": i,
                  "medido_en": (self.ahora - timedelta(minutes=449 - i)).isoformat()}
            r = self.client.post("/api/eventos", json=ev, headers={"X-API-Key": self.config["DEVICE_KEY"]})
            self.assertEqual(r.status_code, 201)

    def tearDown(self):
        self.tmp.cleanup()

    def get(self, query, headers=True):
        return self.client.get(f"/api/pasos/tunel-01/exportar?{query}",
                               headers={"X-API-Key": self.config["API_KEY"]} if headers else {})

    def test_csv_completo_en_un_pedido(self):
        r = self.get("formato=csv")
        self.assertEqual(r.status_code, 200)
        self.assertIn("attachment", r.headers["Content-Disposition"])
        texto = r.get_data(as_text=True)
        self.assertTrue(texto.startswith("﻿"))
        filas = list(csv.DictReader(io.StringIO(texto.lstrip("﻿"))))
        self.assertEqual(len(filas), 450)
        self.assertEqual(filas[0]["secuencia"], "449")          # del más reciente al más antiguo
        self.assertEqual(filas[0]["agua_activa"], "false")

    def test_json_con_rango_de_fechas(self):
        desde = (self.ahora - timedelta(minutes=59, seconds=30)).isoformat()
        r = self.get(f"formato=json&desde={desde.replace('+', '%2B')}")
        self.assertEqual(r.status_code, 200)
        datos = json.loads(r.get_data(as_text=True))
        self.assertEqual(len(datos), 60)
        self.assertIn("recibido_en", datos[0])
        hasta = (self.ahora - timedelta(minutes=400)).isoformat().replace("+", "%2B")
        self.assertEqual(len(json.loads(self.get(f"formato=json&hasta={hasta}").get_data(as_text=True))), 50)

    def test_validaciones_y_permisos(self):
        self.assertEqual(self.get("formato=csv", headers=False).status_code, 401)
        self.assertEqual(self.get("formato=xml").status_code, 400)
        self.assertEqual(self.get("formato=csv&desde=ayer").status_code, 400)
        self.assertEqual(self.get("formato=csv&desde=2026-11-05T10:00:00").status_code, 400)  # sin zona horaria
        self.assertEqual(self.get("formato=csv&desde=2026-11-06T00:00:00Z&hasta=2026-11-05T00:00:00Z").status_code, 400)
        r = self.client.get("/api/pasos/no-existe/exportar", headers={"X-API-Key": self.config["API_KEY"]})
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
