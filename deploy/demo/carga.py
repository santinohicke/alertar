"""Prueba de carga contra la API local del servidor: paneles abiertos + ESP32 enviando su cola.
Uso: con ALERTAR_API_KEY en el entorno, `python carga.py` en el mismo servidor.
Los envíos usan cuerpo vacío: pasan autenticación y límite de ingesta, y la API los
rechaza con 400 sin guardar nada."""
import json
import os
import random
import statistics
import threading
import time
import urllib.error
import urllib.request
from collections import Counter

API = "http://127.0.0.1:5001"
KEY = os.environ["ALERTAR_API_KEY"]
PANELES, ESP32, DURACION = 20, 10, 60
PASOS = ["tunel-01", "tunel-02", "tunel-03", "tunel-04"]
codigos, tiempos, lock = Counter(), {}, threading.Lock()
fin = time.time() + DURACION


def pedir(tipo, path, data=None):
    req = urllib.request.Request(API + path, data=data, method="POST" if data is not None else "GET",
                                 headers={"X-API-Key": KEY, "Content-Type": "application/json"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception:  # noqa: BLE001
        code = "error"
    dt = (time.perf_counter() - t0) * 1000
    with lock:
        codigos[(tipo, code)] += 1
        tiempos.setdefault(tipo, []).append(dt)


def panel(i):
    time.sleep(random.uniform(0, 5))
    paso = random.choice(PASOS)
    n = 0
    while time.time() < fin:
        pedir("panel", f"/api/panel/{paso}")
        if n % 2 == 0:
            pedir("tuneles", "/api/tuneles")
        if random.random() < 0.15:  # alguien abre Estadísticas o cambia de rango
            pedir("estadisticas", f"/api/pasos/{random.choice(PASOS)}/estadisticas?rango={random.choice(['24h', '7d', 'all'])}")
        n += 1
        time.sleep(5)


def esp32(i):
    while time.time() < fin:  # backlog a 1 evento/s, como RECUPERACION_MS
        pedir("ingesta", "/api/eventos", b"{}")
        time.sleep(1)


hilos = [threading.Thread(target=panel, args=(i,)) for i in range(PANELES)]
hilos += [threading.Thread(target=esp32, args=(i,)) for i in range(ESP32)]
for h in hilos:
    h.start()
for h in hilos:
    h.join()

print(f"{PANELES} paneles + {ESP32} ESP32 durante {DURACION} s")
for tipo in ("panel", "tuneles", "estadisticas", "ingesta"):
    ts = sorted(tiempos.get(tipo, []))
    if not ts:
        continue
    p95 = ts[int(len(ts) * 0.95) - 1]
    res = {str(c): n for (t, c), n in codigos.items() if t == tipo}
    print(f"{tipo:13} n={len(ts):4}  mediana={statistics.median(ts):6.1f} ms  p95={p95:6.1f} ms  max={ts[-1]:6.1f} ms  {res}")
