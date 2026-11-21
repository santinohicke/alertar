"""Estadísticas de un paso calculadas en el servidor.

Reproduce los cálculos que antes hacía el panel en el navegador sobre el historial
completo, pero devuelve solo un resumen chico: totales, tiempo por código, bloques de
actividad, tramos de estado y una serie reducida de obstrucción.
"""
from datetime import datetime, timezone

MUESTRA_S = 15  # Cada evento cuenta hasta 15 s o hasta el siguiente, lo que sea menor.
RANGOS_MS = {"1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000, "all": None}
BLOQUES_FIJOS = {
    "1h": (300_000, "Bloques de 5 minutos"),
    "6h": (1_800_000, "Bloques de 30 minutos"),
    "24h": (3_600_000, "Bloques de 1 hora"),
    "7d": (21_600_000, "Bloques de 6 horas"),
}
FRANJAS = 720        # resolución de la franja de estado
PUNTOS_OBSTRUCCION = 600

SEVERIDAD = {
    "OK-001": "ok", "INF-001": "ok",
    "ERR-001": "crit", "ERR-005": "crit",
    "ERR-002": "warn", "ERR-003": "warn", "ERR-004": "warn", "ERR-006": "warn", "ERR-007": "warn",
}
SEVS = ("ok", "warn", "crit", "unknown")

CONSULTA = """
    SELECT secuencia, recibido_en,
           json_extract(payload, '$.medido_en'), json_extract(payload, '$.codigo'),
           json_extract(payload, '$.arranque_id'), json_extract(payload, '$.agua_activa'),
           json_extract(payload, '$.sensor1_valido'), json_extract(payload, '$.sensor2_valido'),
           json_extract(payload, '$.obstruccion_carril1_cm'), json_extract(payload, '$.obstruccion_carril2_cm')
    FROM eventos WHERE paso_id = ?"""


def _ms(texto):
    if not texto:
        return None
    try:
        d = datetime.fromisoformat(texto)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return int(d.timestamp() * 1000)


def _iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat() if ms is not None else None


def _numero(v):
    if isinstance(v, bool) or v is None:
        return None
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if v == v and v not in (float("inf"), float("-inf")) else None


def leer_eventos(conn, paso_id, rango, ahora_ms):
    """Filas del paso dentro del rango. El filtro por recepción usa un margen porque la
    medición siempre ocurre antes de la recepción (salvo 60 s de tolerancia de reloj)."""
    ventana = RANGOS_MS[rango]
    if ventana is None:
        return conn.execute(CONSULTA, (paso_id,)).fetchall()
    desde = _iso(ahora_ms - ventana - 120_000)
    return conn.execute(CONSULTA + " AND recibido_en >= ?", (paso_id, desde)).fetchall()


def calcular(filas, rango, ahora_ms, total_base, paso_id):
    ventana = RANGOS_MS[rango]
    minimo = None if ventana is None else ahora_ms - ventana

    eventos = []
    for seq, recibido, medido, codigo, arranque, agua, s1, s2, c1, c2 in filas:
        m, r = _ms(medido), _ms(recibido)
        t = m if m is not None else r
        if t is None or (minimo is not None and t < minimo):
            continue
        eventos.append((t, int(seq), m, r, codigo or "SIN CÓDIGO", arranque, bool(agua), bool(s1), bool(s2),
                        _numero(c1) if s1 else None, _numero(c2) if s2 else None))
    eventos.sort(key=lambda e: (e[0], e[1]))

    # ---- Conteos (equivalente a calculateStats del panel anterior)
    arranques, por_arranque = set(), {}
    carril1, carril2, demoras = [], [], []
    sin_fecha, ultima = 0, None
    for t, seq, m, r, codigo, arranque, agua, s1, s2, c1, c2 in eventos:
        if arranque:
            arranques.add(arranque)
            por_arranque.setdefault(arranque, []).append(seq)
        if c1 is not None:
            carril1.append(c1)
        if c2 is not None:
            carril2.append(c2)
        if m is None:
            sin_fecha += 1
        if r is not None and (ultima is None or r > ultima):
            ultima = r
        if m is not None and r is not None and r >= m:
            demoras.append((r - m) / 1000)
    saltos = 0
    for seqs in por_arranque.values():
        seqs.sort()
        saltos += sum(b - a - 1 for a, b in zip(seqs, seqs[1:]) if b - a > 1)

    def resumen(valores):
        return {"promedio": sum(valores) / len(valores) if valores else None,
                "maximo": max(valores) if valores else None}

    # ---- Tiempo por estado (equivalente a calculateTimeStats) y tramos
    codigos = {}
    normal = agua_s = valido1 = valido2 = monitoreado = 0.0
    tramos = []
    for i, (t, seq, m, r, codigo, arranque, agua, s1, s2, c1, c2) in enumerate(eventos):
        siguiente = eventos[i + 1][0] if i + 1 < len(eventos) else None
        dur_ms = MUESTRA_S * 1000 if siguiente is None else min(max(siguiente - t, 0), MUESTRA_S * 1000)
        if not dur_ms:
            continue
        dur = dur_ms / 1000
        monitoreado += dur
        codigos[codigo] = codigos.get(codigo, 0) + dur
        if codigo == "OK-001":
            normal += dur
        if agua:
            agua_s += dur
        if s1:
            valido1 += dur
        if s2:
            valido2 += dur
        sev = SEVERIDAD.get(codigo, "unknown")
        if tramos and tramos[-1][2] == sev and t - tramos[-1][1] <= 1000:
            tramos[-1][1] = t + dur_ms
        else:
            tramos.append([t, t + dur_ms, sev])

    # ---- Bloques de actividad (equivalente a activityConfig + renderActivity)
    actividad = None
    if eventos or ventana is not None:
        if rango in BLOQUES_FIJOS:
            bloque, nombre = BLOQUES_FIJOS[rango]
            inicio, fin = ahora_ms - ventana, ahora_ms
        else:
            inicio, fin = eventos[0][0], eventos[-1][0]
            span = fin - inicio
            bloque, nombre = ((1_800_000, "Bloques de 30 minutos") if span <= 21_600_000 else
                              (3_600_000, "Bloques de 1 hora") if span <= 172_800_000 else
                              (21_600_000, "Bloques de 6 horas") if span <= 1_209_600_000 else
                              (86_400_000, "Bloques de 1 día"))
            fin += bloque
        inicio = inicio // bloque * bloque
        fin = -(-fin // bloque) * bloque
        n = max(1, (fin - inicio) // bloque)
        bloques = [[0, 0, 0, 0, 0] for _ in range(n)]
        for e in eventos:
            k = (e[0] - inicio) // bloque
            if 0 <= k < n:
                bloques[k][0] += 1
        for a, b, sev in tramos:
            k = max(0, (a - inicio) // bloque)
            while k < n and inicio + k * bloque < b:
                ini = inicio + k * bloque
                solape = min(b, ini + bloque) - max(a, ini)
                if solape > 0:
                    bloques[k][1 + SEVS.index(sev)] += solape
                k += 1
        actividad = {"bloque_ms": bloque, "nombre": nombre, "inicio": inicio, "fin": fin, "bloques": bloques}

    # ---- Franja de estado: resolución fija; gana la severidad más grave con al menos 10 %
    estado = []
    if actividad and tramos:
        inicio, fin = actividad["inicio"], actividad["fin"]
        paso = max(1, (fin - inicio) / FRANJAS)
        celdas = [[0.0, 0.0, 0.0, 0.0] for _ in range(FRANJAS)]
        for a, b, sev in tramos:
            a, b = max(a, inicio), min(b, fin)
            if b <= a:
                continue
            k = int((a - inicio) // paso)
            while k < FRANJAS and inicio + k * paso < b:
                ini = inicio + k * paso
                solape = min(b, ini + paso) - max(a, ini)
                if solape > 0:
                    celdas[k][SEVS.index(sev)] += solape
                k += 1
        for k, (ok, warn, crit, unk) in enumerate(celdas):
            cubierto = ok + warn + crit + unk
            if cubierto < paso * 0.2:
                sev = None
            elif crit >= cubierto * 0.1:
                sev = "crit"
            elif warn >= cubierto * 0.1:
                sev = "warn"
            elif ok >= unk:
                sev = "ok"
            else:
                sev = "unknown"
            a = int(inicio + k * paso)
            b = int(inicio + (k + 1) * paso)
            if sev is None:
                continue
            if estado and estado[-1][2] == sev and estado[-1][1] >= a - 1:
                estado[-1][1] = b
            else:
                estado.append([a, b, sev])

    # ---- Obstrucción: máximo por bloque para no perder picos breves
    puntos = [(e[0], e[9], e[10]) for e in eventos if e[9] is not None or e[10] is not None]
    obstruccion = {"bloque_ms": None, "puntos": []}
    if len(puntos) >= 2:
        t0, t1 = puntos[0][0], puntos[-1][0]
        nb = min(len(puntos), PUNTOS_OBSTRUCCION)
        ancho = max(1, (t1 - t0) / nb)
        salida = []
        for t, c1, c2 in puntos:
            k = min(nb - 1, int((t - t0) // ancho))
            if salida and salida[-1][4] == k:
                p = salida[-1]
                if c1 is not None:
                    p[1] = c1 if p[1] is None else max(p[1], c1)
                if c2 is not None:
                    p[2] = c2 if p[2] is None else max(p[2], c2)
                p[3] = t
            else:
                salida.append([t, c1, c2, t, k])
        obstruccion = {"bloque_ms": int(ancho), "puntos": [p[:4] for p in salida]}

    return {
        "paso_id": paso_id,
        "rango": rango,
        "desde": minimo,
        "hasta": ahora_ms,
        "generado_en": _iso(ahora_ms),
        "total_base": total_base,
        "total": len(eventos),
        "arranques": len(arranques),
        "sin_fecha": sin_fecha,
        "ultima_recepcion": _iso(ultima),
        "monitoreado_s": monitoreado,
        "normal_s": normal,
        "agua_s": agua_s,
        "valido1_s": valido1,
        "valido2_s": valido2,
        "codigos": sorted(([c, s] for c, s in codigos.items() if s > 0), key=lambda x: -x[1]),
        "carril1": resumen(carril1),
        "carril2": resumen(carril2),
        "demora": resumen(demoras),
        "saltos": saltos,
        "actividad": actividad,
        "estado": estado,
        "obstruccion": obstruccion,
    }
