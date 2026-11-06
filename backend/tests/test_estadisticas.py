import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import estadisticas
from app import ROOT, _limite, create_app

BASE = datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc)


def fila(seg, seq, codigo="OK-001", arranque="a" * 32, agua=False, s1=True, s2=True, c1=0.0, c2=0.0,
         demora=1.0, medido=True):
    t = BASE + timedelta(seconds=seg)
    return (seq, (t + timedelta(seconds=demora)).isoformat(), t.isoformat() if medido else None, codigo,
            arranque, agua, s1, s2, c1, c2)


class CalculoTests(unittest.TestCase):
    def setUp(self):
        self.ahora = int((BASE + timedelta(seconds=200)).timestamp() * 1000)

    def test_tiempo_por_estado_con_tope_de_15_s(self):
        filas = [fila(0, 1), fila(15, 2, "ERR-006", c1=240.0), fila(20, 5), fila(100, 6, "ERR-001", agua=True)]
        r = estadisticas.calcular(filas, "1h", self.ahora, 10, "tunel-01")
        self.assertEqual(r["total"], 4)
        self.assertEqual(r["monitoreado_s"], 50)          # 15 + 5 + 15 (tope) + 15 (último)
        self.assertEqual(r["normal_s"], 30)
        self.assertEqual(r["agua_s"], 15)
        self.assertEqual(dict(r["codigos"]), {"OK-001": 30, "ERR-001": 15, "ERR-006": 5})
        self.assertEqual(r["saltos"], 2)                   # secuencias 2 → 5
        self.assertEqual(r["carril1"]["maximo"], 240.0)
        self.assertAlmostEqual(r["demora"]["promedio"], 1.0)
        self.assertEqual(r["total_base"], 10)

    def test_rango_excluye_eventos_viejos_y_cuenta_sin_fecha(self):
        filas = [fila(-7200, 1), fila(0, 2), fila(30, 3, medido=False)]
        r = estadisticas.calcular(filas, "1h", self.ahora, 3, "tunel-01")
        self.assertEqual(r["total"], 2)
        self.assertEqual(r["sin_fecha"], 1)
        todo = estadisticas.calcular(filas, "all", self.ahora, 3, "tunel-01")
        self.assertEqual(todo["total"], 3)

    def test_bloques_franja_y_obstruccion(self):
        filas = [fila(i * 15, i, "ERR-001" if 40 <= i < 50 else "OK-001", c1=float(i)) for i in range(120)]
        ahora = int((BASE + timedelta(minutes=31)).timestamp() * 1000)
        r = estadisticas.calcular(filas, "1h", ahora, 120, "tunel-01")
        act = r["actividad"]
        self.assertEqual(act["bloque_ms"], 300_000)
        self.assertEqual(sum(b[0] for b in act["bloques"]), 120)
        self.assertIn("crit", {s for _, _, s in r["estado"]})
        self.assertLessEqual(len(r["obstruccion"]["puntos"]), estadisticas.PUNTOS_OBSTRUCCION)
        self.assertEqual(max(p[1] for p in r["obstruccion"]["puntos"]), 119.0)

    def test_sin_eventos(self):
        r = estadisticas.calcular([], "all", self.ahora, 0, "tunel-01")
        self.assertEqual((r["total"], r["actividad"], r["estado"]), (0, None, []))


class EndpointYLimitesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT / ".test-tmp")
        self.config = dict(TESTING=True, DATABASE=str(Path(self.tmp.name) / "s.db"), REQUIRE_AUTH=True,
                           API_KEY="master-" + "a" * 32, DEVICE_KEY="device-" + "b" * 32,
                           RATE_LIMIT_ENABLED=False, SESSION_COOKIE_SECURE=True, STATS_CACHE_S=0)
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.event = json.loads((ROOT / "examples/evento.json").read_text())

    def tearDown(self):
        self.tmp.cleanup()

    def master(self):
        return {"X-API-Key": self.config["API_KEY"]}

    def test_endpoint_requiere_sesion_y_valida(self):
        url = "/api/pasos/tunel-01/estadisticas?rango=24h"
        self.assertEqual(self.client.get(url).status_code, 401)
        self.assertEqual(self.client.get(url, headers={"X-API-Key": self.config["DEVICE_KEY"]}).status_code, 401)
        self.assertEqual(self.client.get("/api/pasos/tunel-01/estadisticas?rango=2d", headers=self.master()).status_code, 400)
        self.assertEqual(self.client.get("/api/pasos/no-existe/estadisticas", headers=self.master()).status_code, 404)
        ahora = datetime.now(timezone.utc).replace(microsecond=0)
        ev = {**self.event, "medido_en": ahora.isoformat()}
        self.assertEqual(self.client.post("/api/eventos", json=ev, headers={"X-API-Key": self.config["DEVICE_KEY"]}).status_code, 201)
        r = self.client.get(url, headers=self.master())
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json["total"], r.json["total_base"]), (1, 1))

    def test_limites_por_defecto_admiten_rafagas_de_varios_dispositivos(self):
        app = create_app({**self.config, "RATE_LIMIT_ENABLED": True})
        client = app.test_client()
        key = {"X-API-Key": self.config["DEVICE_KEY"]}
        codigos = []
        for i in range(30):  # 30 envíos seguidos: con el límite anterior (ráfaga 4) fallaban desde el 5.º
            ev = {**self.event, "evento_id": f"e-{i}", "secuencia": i}
            codigos.append(client.post("/api/eventos", json=ev, headers=key).status_code)
        self.assertNotIn(429, codigos)
        lecturas = [client.get("/api/panel/tunel-01", headers=self.master()).status_code for _ in range(40)]
        self.assertNotIn(429, lecturas)

    def test_limites_configurables_desde_el_entorno(self):
        with mock.patch.dict(os.environ, {"ALERTAR_LIMITE_INGESTA": "2,4", "ALERTAR_LIMITE_LECTURA": "x"}):
            self.assertEqual(_limite("ALERTAR_LIMITE_INGESTA", (20, 60)), (2.0, 4.0))
            self.assertEqual(_limite("ALERTAR_LIMITE_LECTURA", (30, 90)), (30, 90))


if __name__ == "__main__":
    unittest.main()
