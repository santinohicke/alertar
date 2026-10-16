#!/usr/bin/env python3
"""
Simulador CLI de Telemetría ESP32 / Wokwi para AlertAR
Permite simular uno o múltiples pasos a nivel (túneles) enviando telemetría
de sensores de agua, obstrucción y diagnóstico al backend.
"""
import argparse
import json
import random
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

DEFAULT_MASTER_KEY = "LdoRaJnIdeK51hZDjeTOV2OvTyDcXC6rcihQQ4NUSB4"
DEFAULT_URL = "http://127.0.0.1:5001"

ESCENARIOS = {
    "normal": {
        "codigo": "OK-001",
        "diag": "Paso habilitado - Situacion normal en {nombre}",
        "agua_activa": False,
        "agua_pendiente": False,
        "c1_valido": True,
        "c1_obs": 0.0,
        "c2_valido": True,
        "c2_obs": 0.0,
    },
    "obstruccion": {
        "codigo": "INF-001",
        "diag": "Vehiculo con exceso de galibo detenido en {nombre}",
        "agua_activa": False,
        "agua_pendiente": False,
        "c1_valido": True,
        "c1_obs": 185.0,
        "c2_valido": True,
        "c2_obs": 0.0,
    },
    "agua": {
        "codigo": "ERR-001",
        "diag": "Inundacion critica en {nombre} - Paso cerrado",
        "agua_activa": True,
        "agua_pendiente": False,
        "c1_valido": True,
        "c1_obs": 0.0,
        "c2_valido": True,
        "c2_obs": 0.0,
    },
    "falla": {
        "codigo": "ERR-002",
        "diag": "Falla de lectura sensor carril 2 en {nombre}",
        "agua_activa": False,
        "agua_pendiente": False,
        "c1_valido": True,
        "c1_obs": 0.0,
        "c2_valido": False,
        "c2_obs": None,
    }
}


def http_request(url, method="GET", data=None, headers=None):
    hdrs = headers or {}
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode("utf-8")
            return resp.status, json.loads(content) if content else {}
    except urllib.error.HTTPError as e:
        content = e.read().decode("utf-8")
        try:
            parsed = json.loads(content)
        except Exception:
            parsed = {"error": content}
        return e.code, parsed
    except Exception as e:
        return 0, {"error": str(e)}


def obtener_tuneles(base_url, api_key):
    status, data = http_request(f"{base_url}/api/tuneles", headers={"X-API-Key": api_key})
    if status != 200:
        print(f"[!] Error al obtener túneles (HTTP {status}): {data.get('error', data)}")
        return []
    return data.get("tuneles", [])


def obtener_ultima_secuencia(base_url, paso_id, api_key):
    url = f"{base_url}/api/pasos/{paso_id}/historial?limite=1"
    status, data = http_request(url, headers={"X-API-Key": api_key})
    if status == 200:
        evs = data.get("eventos", [])
        if evs:
            return evs[0].get("secuencia", 0)
    return random.randint(10, 100)


class TunelSimulado:
    def __init__(self, paso_id, nombre, dispositivo_id, api_key_tunel, master_key, base_url):
        self.paso_id = paso_id
        self.nombre = nombre
        self.dispositivo_id = dispositivo_id
        self.api_key = api_key_tunel or master_key
        self.base_url = base_url
        self.secuencia = obtener_ultima_secuencia(base_url, paso_id, master_key)
        self.arranque_id = f"arranque-sim-{dispositivo_id}"
        self.uptime_ms = 10000

    def enviar_evento(self, tipo="normal"):
        self.secuencia += 1
        self.uptime_ms += 5000
        now_iso = datetime.now(timezone.utc).isoformat()

        cfg = ESCENARIOS.get(tipo, ESCENARIOS["normal"])
        diagnostico = cfg["diag"].format(nombre=self.nombre)

        c1_obs = cfg["c1_obs"]
        if c1_obs is not None and c1_obs > 0:
            c1_obs = round(c1_obs + random.uniform(-2.0, 2.0), 1)

        payload = {
            "version": 1,
            "evento_id": f"{self.dispositivo_id}-{self.secuencia}-{random.randint(1000, 9999)}",
            "dispositivo_id": self.dispositivo_id,
            "paso_id": self.paso_id,
            "arranque_id": self.arranque_id,
            "secuencia": self.secuencia,
            "uptime_ms": self.uptime_ms,
            "medido_en": now_iso,
            "codigo": cfg["codigo"],
            "diagnostico": diagnostico,
            "sensor1_valido": cfg["c1_valido"],
            "sensor2_valido": cfg["c2_valido"],
            "obstruccion_carril1_cm": c1_obs,
            "obstruccion_carril2_cm": cfg["c2_obs"],
            "agua_activa": cfg["agua_activa"],
            "agua_pendiente": cfg["agua_pendiente"],
        }

        url = f"{self.base_url}/api/eventos"
        status, res = http_request(url, method="POST", data=payload, headers={"X-API-Key": self.api_key})

        simbolo = {
            "OK-001": "🟢",
            "INF-001": "🟡",
            "ERR-001": "🔴",
            "ERR-002": "⚠️"
        }.get(cfg["codigo"], "⚪")

        if status in (200, 201):
            print(f"[{datetime.now().strftime('%H:%M:%S')}] {simbolo} [{self.paso_id}] {cfg['codigo']} Sec #{self.secuencia}: {diagnostico}")
            return True
        else:
            print(f"[!] Error enviando a {self.paso_id} (HTTP {status}): {res.get('detalle', res.get('error', res))}")
            return False


def main():
    parser = argparse.ArgumentParser(description="Simulador CLI de Telemetría ESP32 / AlertAR")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"URL base del backend (def: {DEFAULT_URL})")
    parser.add_argument("--key", default=DEFAULT_MASTER_KEY, help="Master API Key o Device Key")
    parser.add_argument("--tunel", default=None, help="ID del paso específico (ej: tunel-01). Por defecto: todos los túneles.")
    parser.add_argument("--tipo", choices=["normal", "obstruccion", "agua", "falla", "aleatorio"], default="normal",
                        help="Escenario a simular (def: normal)")
    parser.add_argument("--loop", type=float, default=0, help="Intervalo en segundos para simulación continua en bucle (ej: --loop 5)")
    parser.add_argument("--veces", type=int, default=1, help="Cantidad de disparos a realizar si no se usa --loop (def: 1)")

    args = parser.parse_args()
    base_url = args.url.rstrip("/")

    print("=" * 60)
    print("  🚨 AlertAR - Simulador CLI de Telemetría ESP32 / Sensores")
    print(f"  Target: {base_url}")
    print("=" * 60)

    tuneles_data = obtener_tuneles(base_url, args.key)
    if not tuneles_data:
        print("[!] No se encontraron túneles o no hay autorización.")
        sys.exit(1)

    if args.tunel:
        tuneles_filtrados = [t for t in tuneles_data if t["paso_id"] == args.tunel]
        if not tuneles_filtrados:
            print(f"[!] El túnel '{args.tunel}' no existe. Disponibles: {', '.join([t['paso_id'] for t in tuneles_data])}")
            sys.exit(1)
    else:
        tuneles_filtrados = tuneles_data

    print(f"[*] Pasos a nivel objetivos ({len(tuneles_filtrados)}):")
    simuladores = []
    for t in tuneles_filtrados:
        sim = TunelSimulado(
            paso_id=t["paso_id"],
            nombre=t["nombre"],
            dispositivo_id=t["dispositivo_id"],
            api_key_tunel=t.get("api_key", args.key),
            master_key=args.key,
            base_url=base_url
        )
        simuladores.append(sim)
        print(f"    - {t['paso_id']} ({t['nombre']}) -> Dispositivo {t['dispositivo_id']}")

    print("-" * 60)

    def ejecutar_ronda():
        for sim in simuladores:
            esc = args.tipo
            if esc == "aleatorio":
                esc = random.choices(["normal", "obstruccion", "agua", "falla"], weights=[70, 15, 10, 5])[0]
            sim.enviar_evento(esc)

    if args.loop > 0:
        print(f"[*] Iniciando simulación continua cada {args.loop}s (Presioná CTRL+C para detener)...")
        try:
            while True:
                ejecutar_ronda()
                time.sleep(args.loop)
        except KeyboardInterrupt:
            print("\n[!] Simulación detenida por el usuario.")
    else:
        for i in range(args.veces):
            if args.veces > 1:
                print(f"\n--- Ronda {i+1}/{args.veces} ---")
            ejecutar_ronda()
            if i < args.veces - 1:
                time.sleep(1)

    print("\n[✓] Telemetría enviada con éxito.")


if __name__ == "__main__":
    main()
