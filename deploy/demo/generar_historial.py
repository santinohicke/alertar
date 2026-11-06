"""SOLO PARA LA DEMO. Reemplaza el historial de los pasos de PASOS por días artificiales
generados con las reglas y textos del firmware (AlertAR-2/src/logica.h).

No crea pasos ni cambia claves: los pasos deben existir (por nombre) en la API.
Borra sus eventos y reservas actuales y carga HORAS de historial que termina
`apagado_min` minutos antes de ahora, así los pasos quedan apagados.

Uso, en el servidor y con el entorno privado cargado:
    set -a; . ~/.config/alertar/alertar.env; set +a
    ~/alertar/venv/bin/python generar_historial.py
Hacer antes un respaldo de la base."""
import json
import os
import random
import secrets
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

DB = os.path.expanduser("~/alertar/data/alertar.sqlite3")
API = "http://127.0.0.1:5001"
KEY = os.environ["ALERTAR_API_KEY"]
LOCAL = timezone(timedelta(hours=-3))
random.seed(20261105)
NOW = datetime.now(timezone.utc).replace(microsecond=0)

# Textos del firmware (AlertAR-2/src/logica.h)
DIAG = {
    "OK-001": "Situacion normal",
    "INF-001": "Ocupacion transitoria",
    "ERR-001": "Agua critica confirmada",
    "ERR-002": "Agua pendiente de confirmacion",
    "ERR-003": "Lectura ultrasonica invalida",
    "ERR-004": "Obstruccion en ambos carriles",
    "ERR-005": "Bloqueo persistente en ambos carriles",
    "ERR-006": "Obstruccion alta persistente en un carril",
    "ERR-007": "Obstruccion en un carril",
}

# Tormentas compartidas por toda la ciudad: (días atrás, hora, minuto, duración en minutos).
def _tormenta(dias, h, m, minutos):
    d = (NOW.astimezone(LOCAL) - timedelta(days=dias)).date()
    a = datetime(d.year, d.month, d.day, h, m, tzinfo=LOCAL)
    return a, a + timedelta(minutes=minutos)
TORMENTAS = [_tormenta(1, 21, 30, 105), _tormenta(5, 14, 10, 150), _tormenta(10, 3, 20, 100)]

PASOS = [
    dict(nombre="Paso Floresta", ubicacion="Bahía Blanca y vías del Sarmiento, Floresta",
         latitud=-34.6290, longitud=-58.4850, apagado_min=40, inundacion=(14, 72)),
    dict(nombre="Paso Colegiales", ubicacion="Av. Federico Lacroze y vías del Mitre, Colegiales",
         latitud=-34.5633, longitud=-58.4465, apagado_min=135, inundacion=None, corte_hora=3),
    dict(nombre="Paso Villa Soldati", ubicacion="Av. Escalada y vías del Belgrano Sur, Villa Soldati",
         latitud=-34.6590, longitud=-58.4540, apagado_min=360, inundacion=(6, 95)),
]
HORAS = 24 * 14


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"X-API-Key": KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


def episodios(inicio, fin, paso):
    """Lista de (desde, hasta, codigo, extra) en datetime UTC."""
    eps = []
    t = inicio
    # Tránsito: ocupaciones transitorias, más frecuentes de día.
    while t < fin:
        h = t.astimezone(LOCAL).hour
        media = 170 if 7 <= h < 21 else 900
        if t.astimezone(LOCAL).weekday() >= 5:
            media *= 1.7
        t += timedelta(seconds=random.expovariate(1 / media))
        dur = random.randint(8, 40)
        alto = random.choice([150, 160, 165, 170, 175, 210, 225, 300])
        carril = random.choice([1, 2])
        ambos = random.random() < 0.15
        eps.append((t, t + timedelta(seconds=dur), "INF-001", dict(carril=carril, alto=alto, ambos=ambos)))
    # Vehículo detenido (alta persistente en un carril) y objeto bajo.
    dias = (fin - inicio).total_seconds() / 86400
    for _ in range(int(dias * random.uniform(1.5, 3))):
        t = inicio + timedelta(seconds=random.uniform(0, (fin - inicio).total_seconds() - 3600))
        carril = random.choice([1, 2])
        eps.append((t, t + timedelta(seconds=60), "INF-001", dict(carril=carril, alto=240, ambos=False)))
        eps.append((t + timedelta(seconds=60), t + timedelta(seconds=60 + random.randint(120, 720)), "ERR-006",
                    dict(carril=carril, alto=random.choice([235, 248, 262, 290]))))
    for _ in range(max(1, int(dias / 2))):
        t = inicio + timedelta(seconds=random.uniform(0, (fin - inicio).total_seconds() - 3600))
        eps.append((t, t + timedelta(seconds=60), "INF-001", dict(carril=1, alto=60, ambos=False)))
        eps.append((t + timedelta(seconds=60), t + timedelta(seconds=60 + random.randint(180, 900)), "ERR-007",
                    dict(carril=1, alto=random.choice([45, 58, 72]))))
    # Embotellamiento en hora pico: ambos carriles ocupados.
    dia = inicio.astimezone(LOCAL).date()
    for d in (dia + timedelta(days=k) for k in range(int(dias) + 2)):
        if d.weekday() >= 5:
            continue
        for hora in (8, 18):
            t = datetime(d.year, d.month, d.day, hora, random.randint(5, 50), tzinfo=LOCAL).astimezone(timezone.utc)
            if inicio < t < fin - timedelta(minutes=15):
                eps.append((t, t + timedelta(seconds=60), "INF-001", dict(carril=1, alto=165, ambos=True)))
                eps.append((t + timedelta(seconds=60), t + timedelta(seconds=60 + random.randint(120, 420)),
                            "ERR-004", dict(alto=165)))
    # Falla de sensor (carril 2 sin lectura).
    for _ in range(max(1, int(dias / 4))):
        t = inicio + timedelta(seconds=random.uniform(3600, (fin - inicio).total_seconds() - 3600))
        eps.append((t, t + timedelta(seconds=random.randint(180, 600)), "ERR-003", {}))
    # Tormenta.
    for n, (ts, te) in enumerate(TORMENTAS):
        ts = ts.astimezone(timezone.utc)
        if not inicio < ts < fin:
            continue
        if paso["inundacion"]:
            retraso, minutos = paso["inundacion"]
            factor = (1.0, 1.3, 0.7)[n]
            a = ts + timedelta(minutes=retraso + random.randint(-4, 6))
            eps.append((a, a + timedelta(seconds=20), "ERR-002", {}))
            eps.append((a + timedelta(seconds=20), a + timedelta(minutes=minutos * factor), "ERR-001", {}))
        else:
            for m in (22, 51):
                a = ts + timedelta(minutes=m + random.randint(-5, 5))
                eps.append((a, a + timedelta(seconds=random.randint(6, 15)), "ERR-002", {}))
    return eps


PRIORIDAD = ["ERR-001", "ERR-003", "ERR-005", "ERR-002", "ERR-004", "ERR-006", "ERR-007", "INF-001"]


def estado(t, activos):
    """Código y lecturas en el instante t según la prioridad de tabla_logica.md."""
    vigentes = [e for e in activos if e[0] <= t < e[1]]
    if not vigentes:
        return "OK-001", {}
    vigentes.sort(key=lambda e: PRIORIDAD.index(e[2]))
    return vigentes[0][2], vigentes[0][3]


def generar(paso, dispositivo, paso_id):
    fin = NOW - timedelta(minutes=paso["apagado_min"])
    inicio = fin - timedelta(hours=HORAS)
    eps = sorted(episodios(inicio, fin, paso), key=lambda e: e[0])
    total_s = (fin - inicio).total_seconds()
    reinicios = sorted(inicio + timedelta(seconds=random.uniform(0.05, 0.95) * total_s)
                       for _ in range(max(1, int(total_s / 86400 / 4))))
    cortes = sorted((a, a + timedelta(minutes=random.randint(5, 20)))
                    for a in (inicio + timedelta(seconds=random.uniform(0.05, 0.95) * total_s)
                              for _ in range(max(1, int(total_s / 86400 / 7)))))
    if paso.get("corte_hora") is not None:
        d = fin.astimezone(LOCAL).date()
        a = datetime(d.year, d.month, d.day, paso["corte_hora"], 10, tzinfo=LOCAL).astimezone(timezone.utc)
        if inicio < a < fin:
            cortes.append((a, a + timedelta(minutes=12)))

    arranque = secrets.token_hex(16)
    boot_t = inicio - timedelta(minutes=random.randint(30, 300))
    filas, seq = [], 0
    ultimo_envio, ultimo_codigo = None, None
    cola = []  # eventos medidos durante el corte, enviados al reconectar
    i, t = 0, inicio
    while t < fin:
        if reinicios and t >= reinicios[0]:
            t = reinicios.pop(0) + timedelta(seconds=70)
            arranque = secrets.token_hex(16)
            boot_t = t - timedelta(seconds=2)
            ultimo_envio = None
            continue
        while i < len(eps) and eps[i][1] <= t - timedelta(hours=1):
            i += 1
        codigo, extra = estado(t, eps[i:i + 400])
        if ultimo_envio is None or codigo != ultimo_codigo or (t - ultimo_envio).total_seconds() >= 15:
            c1 = c2 = 0.0
            s2 = codigo != "ERR-003"
            if codigo in ("INF-001", "ERR-006", "ERR-007"):
                alto = extra.get("alto", 160) + random.uniform(-2.5, 2.5)
                if extra.get("ambos"):
                    c1 = c2 = round(alto, 1)
                elif extra.get("carril", 1) == 1:
                    c1 = round(alto, 1)
                else:
                    c2 = round(alto, 1)
            elif codigo == "ERR-004":
                c1, c2 = round(extra["alto"] + random.uniform(-4, 4), 1), round(152 + random.uniform(-4, 4), 1)
            elif codigo == "OK-001" and random.random() < 0.04:
                c1 = round(random.uniform(1, 4), 1)
            medido = t.replace(microsecond=0)
            ev = {
                "version": 1, "evento_id": f"{dispositivo}-{arranque}-{seq}", "dispositivo_id": dispositivo,
                "paso_id": paso_id, "arranque_id": arranque, "secuencia": seq,
                "uptime_ms": int((t - boot_t).total_seconds() * 1000), "medido_en": medido.isoformat(),
                "codigo": codigo, "diagnostico": DIAG[codigo], "sensor1_valido": True, "sensor2_valido": s2,
                "obstruccion_carril1_cm": c1, "obstruccion_carril2_cm": c2 if s2 else None,
                "agua_activa": codigo == "ERR-001", "agua_pendiente": codigo == "ERR-002",
            }
            if any(a <= t < b for a, b in cortes):
                cola.append(ev)
            else:
                if cola:  # al reconectar, el backlog sale a 1 evento/s
                    base = t
                    for k, old in enumerate(cola):
                        filas.append((old, base + timedelta(seconds=k + random.uniform(0.2, 0.6))))
                    cola = []
                filas.append((ev, medido + timedelta(seconds=random.uniform(0.25, 1.4))))
            seq += 1
            ultimo_envio, ultimo_codigo = t, codigo
        t += timedelta(seconds=1)
    return [(e["evento_id"], dispositivo, paso_id, e["secuencia"], iso(r),
             json.dumps(e, sort_keys=True, ensure_ascii=False, allow_nan=False)) for e, r in filas]


def main():
    existentes = {t["nombre"]: t for t in api("GET", "/api/tuneles")["tuneles"]}
    con = sqlite3.connect(DB, timeout=30)
    for p in PASOS:
        t = existentes[p["nombre"]]
        disp, paso_id = t["dispositivo_id"], t["paso_id"]
        filas = generar(p, disp, paso_id)
        with con:
            con.execute("BEGIN IMMEDIATE")
            con.execute("DELETE FROM eventos WHERE dispositivo_id = ?", (disp,))
            con.execute("DELETE FROM instalaciones WHERE dispositivo_id = ?", (disp,))
            # Instalación histórica: la próxima reserva del firmware empieza en 2^32.
            con.execute("INSERT INTO instalaciones VALUES (?,?,?,?)", (disp, secrets.token_hex(16), 0, 2**32))
            con.executemany("INSERT INTO eventos (evento_id, dispositivo_id, paso_id, secuencia, recibido_en, payload)"
                            " VALUES (?,?,?,?,?,?)", filas)
        codigos = {}
        for f in filas:
            c = json.loads(f[5])["codigo"]
            codigos[c] = codigos.get(c, 0) + 1
        print(paso_id, disp, len(filas), "eventos", filas[0][4][:16], "→", filas[-1][4][:16], dict(sorted(codigos.items())))


main()
