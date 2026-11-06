"""Panel y protección de recursos. Sin dependencias fuera de Flask/stdlib."""
import hashlib
import hmac
import secrets
import threading
import time

import json
import re
from datetime import datetime, timedelta, timezone

import csv
import io
import sqlite3

from flask import Response, g, jsonify, redirect, render_template, request, session, url_for

if __package__:
    from . import estadisticas
else:
    import estadisticas


RUTAS_ADMIN = ("crear_tunel", "editar_tunel", "rotar_clave_tunel", "eliminar_tunel",
               "simular_evento", "simular_todos")


def leer_ubicacion(body):
    """Devuelve (ubicacion, latitud, longitud) validados o lanza ValueError."""
    ubicacion = body.get("ubicacion")
    if ubicacion is not None:
        ubicacion = str(ubicacion).strip()[:120] or None
    lat, lon = body.get("latitud"), body.get("longitud")
    if lat is None and lon is None:
        return ubicacion, None, None
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        raise ValueError("latitud y longitud deben ser números.") from None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Coordenadas fuera de rango.")
    return ubicacion, lat, lon


class Cubo:
    """Token bucket de tamaño constante, compartido por hilos del único proceso."""
    def __init__(self, ritmo, capacidad, reloj=time.monotonic):
        self.ritmo, self.capacidad, self.reloj = ritmo, capacidad, reloj
        self.tokens, self.ultimo = float(capacidad), reloj()
        self.lock = threading.Lock()

    def tomar(self):
        with self.lock:
            ahora = self.reloj()
            self.tokens = min(self.capacidad, self.tokens + (ahora - self.ultimo) * self.ritmo)
            self.ultimo = ahora
            if self.tokens < 1:
                return False
            self.tokens -= 1
            return True


def registrar_panel(app, db, estado, record):
    required = app.config["REQUIRE_AUTH"]
    master = app.config["API_KEY"]
    device = app.config["DEVICE_KEY"]
    if required and len(master) < 24:
        raise RuntimeError("Configurar ALERTAR_API_KEY (mínimo 24 caracteres) antes de publicar.")
    app.secret_key = hashlib.sha256(("alertar-panel-session:" + master).encode()).digest() if master else secrets.token_bytes(32)
    # Sin diccionarios por IP que crezcan indefinidamente. Límites globales por proceso,
    # configurables con ALERTAR_LIMITE_* y ALERTAR_CONCURRENCIA (ver app.py).
    cubos = {tipo: Cubo(*valores) for tipo, valores in app.config["RATE_LIMITS"].items()}
    activos = threading.BoundedSemaphore(max(1, int(app.config["CONCURRENCIA"])))
    app.extensions["alertar_cubos"] = cubos

    def igual(provista, esperada):
        return bool(esperada) and hmac.compare_digest(provista.encode(), esperada.encode())

    def limitado():
        response = jsonify(error="ritmo_excedido", detalle="Reintentar sin descartar registros.")
        response.status_code = 429
        response.headers["Retry-After"] = "5"
        return response

    @app.before_request
    def proteger():
        if request.endpoint == "static":
            return None
        if not activos.acquire(blocking=False):
            return limitado()
        g.alertar_slot = True
        if request.content_length and request.content_length > app.config["MAX_CONTENT_LENGTH"]:
            return jsonify(error="cuerpo_excesivo"), 413
        api = request.path.startswith("/api/")
        escritura = request.method not in ("GET", "HEAD", "OPTIONS")
        if required and api:
            key = request.headers.get("X-API-Key", "")
            es_master = igual(key, master)

            hash_clave = app.extensions["alertar_hash"]
            tunel_auth = None
            if key and not es_master:
                tunel_auth = db().execute("SELECT * FROM tuneles WHERE api_key = ?", (hash_clave(key),)).fetchone()
                if not tunel_auth and device and igual(key, device):
                    tunel_auth = db().execute("SELECT * FROM tuneles WHERE paso_id = 'tunel-01'").fetchone()

            ruta_ingesta = request.endpoint in ("receive", "reserve")
            if es_master:
                g.es_master = True
            elif tunel_auth and escritura and ruta_ingesta:
                g.auth_paso_id = tunel_auth["paso_id"]
                g.auth_device_id = tunel_auth["dispositivo_id"]
            elif not escritura and session.get("lector"):
                pass
            elif escritura and session.get("lector") and request.endpoint in RUTAS_ADMIN:
                # Escrituras con cookie de sesión exigen token CSRF; con la clave principal no hace falta.
                if not igual(request.headers.get("X-CSRF-Token", ""), session.get("csrf", "")):
                    return jsonify(error="csrf_invalido"), 403
            else:
                return jsonify(error="no_autorizado"), 401
        if request.endpoint == "login" and request.method == "POST":
            tipo = "login"
        elif api and request.endpoint in RUTAS_ADMIN:
            tipo = "admin"  # no compite con la ingesta de los dispositivos
        elif api:
            tipo = "ingesta" if escritura else "lectura"
        else:
            return None
        if app.config["RATE_LIMIT_ENABLED"] and not cubos[tipo].tomar():
            return limitado()

    @app.teardown_request
    def liberar(error=None):
        if g.pop("alertar_slot", False):
            activos.release()

    @app.after_request
    def cabeceras(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        if request.endpoint != "static":
            response.headers["Cache-Control"] = "no-store"
        return response

    def csrf():
        if "csrf" not in session:
            session["csrf"] = secrets.token_urlsafe(24)
        return session["csrf"]

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if not required:
            return redirect(url_for("panel"))
        error = None
        status = 200
        if request.method == "POST":
            if not igual(request.form.get("csrf", ""), session.get("csrf", "")):
                error, status = "La sesión del formulario venció. Volvé a intentar.", 400
            elif igual(request.form.get("clave", ""), master):
                session.clear()
                session["lector"] = True
                session.permanent = True
                return redirect(url_for("panel"))
            else:
                error, status = "Clave incorrecta.", 401
        return render_template("login.html", csrf=csrf(), error=error), status

    @app.post("/salir")
    def salir():
        if not igual(request.form.get("csrf", ""), session.get("csrf", "")):
            return "Formulario inválido", 400
        session.clear()
        return redirect(url_for("login"))

    @app.get("/")
    def panel():
        if required and not session.get("lector"):
            return redirect(url_for("login"))
        return render_template("panel.html", csrf=csrf(), protegido=required)

    @app.get("/api/panel/<paso_id>")
    def panel_datos(paso_id):
        tunel = None
        try:
            tunel = db().execute("SELECT paso_id FROM tuneles WHERE paso_id = ?", (paso_id,)).fetchone()
        except Exception:
            pass
        if not tunel and paso_id not in app.config["DISPOSITIVOS"]:
            return jsonify(error="paso_desconocido"), 404
        response = app.make_response(estado(paso_id))
        snapshot = response.get_json() if response.status_code == 200 else None
        rows = db().execute("SELECT * FROM eventos WHERE paso_id=? ORDER BY secuencia DESC LIMIT 20", (paso_id,)).fetchall()
        return jsonify(estado=snapshot, eventos=[record(row) for row in rows], intervalo_s=15,
                       vigencia_s=app.config["STALE_SECONDS"])

    def autorizado_admin():
        return not required or getattr(g, "es_master", False) or bool(session.get("lector"))

    def publico(r, ultimo=None):
        return {
            "paso_id": r["paso_id"], "nombre": r["nombre"], "dispositivo_id": r["dispositivo_id"],
            "creado_en": r["creado_en"], "ubicacion": r["ubicacion"],
            "latitud": r["latitud"], "longitud": r["longitud"],
        }

    # Caché corta: varios paneles mirando el mismo paso comparten el cálculo.
    cache_stats, lock_stats = {}, threading.Lock()

    @app.get("/api/pasos/<paso_id>/estadisticas")
    def estadisticas_paso(paso_id):
        rango = request.args.get("rango", "24h")
        if rango not in estadisticas.RANGOS_MS:
            return jsonify(error="rango_invalido", detalle="Usar 1h, 6h, 24h, 7d o all."), 400
        conn = db()
        if not conn.execute("SELECT 1 FROM tuneles WHERE paso_id = ?", (paso_id,)).fetchone():
            return jsonify(error="tunel_no_encontrado"), 404
        clave = (paso_id, rango)
        ahora = time.monotonic()
        with lock_stats:
            guardado = cache_stats.get(clave)
            if guardado and ahora - guardado[0] < app.config.get("STATS_CACHE_S", 10):
                return jsonify(guardado[1])
        ahora_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        total = conn.execute("SELECT COUNT(*) FROM eventos WHERE paso_id = ?", (paso_id,)).fetchone()[0]
        filas = estadisticas.leer_eventos(conn, paso_id, rango, ahora_ms)
        resultado = estadisticas.calcular(filas, rango, ahora_ms, total, paso_id)
        with lock_stats:
            if len(cache_stats) > 200:
                cache_stats.clear()
            cache_stats[clave] = (ahora, resultado)
        return jsonify(resultado)

    # Exportación completa generada en el servidor y enviada por partes (streaming): un solo
    # pedido sin importar la cantidad de registros, sin cargar todo en memoria.
    COLUMNAS_EXPORT = ["evento_id", "dispositivo_id", "paso_id", "secuencia", "recibido_en", "medido_en",
                       "codigo", "diagnostico", "agua_activa", "agua_pendiente", "obstruccion_carril1_cm",
                       "obstruccion_carril2_cm", "sensor1_valido", "sensor2_valido", "uptime_ms", "arranque_id",
                       "version"]

    def fecha_param(nombre):
        texto = request.args.get(nombre)
        if not texto:
            return None
        d = datetime.fromisoformat(texto.replace("Z", "+00:00"))
        if d.tzinfo is None:
            raise ValueError("La fecha debe incluir zona horaria.")
        return d.astimezone(timezone.utc)

    @app.get("/api/pasos/<paso_id>/exportar")
    def exportar_paso(paso_id):
        formato = request.args.get("formato", "csv")
        if formato not in ("csv", "json"):
            return jsonify(error="formato_invalido", detalle="Usar csv o json."), 400
        try:
            desde, hasta = fecha_param("desde"), fecha_param("hasta")
        except ValueError:
            return jsonify(error="fecha_invalida", detalle="Usar ISO 8601 con zona horaria."), 400
        if desde and hasta and desde > hasta:
            return jsonify(error="rango_invalido", detalle="desde es posterior a hasta."), 400
        if not db().execute("SELECT 1 FROM tuneles WHERE paso_id = ?", (paso_id,)).fetchone():
            return jsonify(error="tunel_no_encontrado"), 404

        consulta = "SELECT recibido_en, payload FROM eventos WHERE paso_id = ?"
        params = [paso_id]
        if desde:  # la medición siempre es anterior a la recepción (salvo 60 s de reloj)
            consulta += " AND recibido_en >= ?"
            params.append((desde - timedelta(seconds=120)).isoformat())
        consulta += " ORDER BY secuencia DESC"
        ruta = app.config["DATABASE"]

        def en_rango(evento, recibido):
            fecha = evento.get("medido_en") or recibido
            try:
                t = datetime.fromisoformat(fecha)
            except (TypeError, ValueError):
                return desde is None and hasta is None
            return (desde is None or t >= desde) and (hasta is None or t <= hasta)

        def filas():
            # Conexión propia: la respuesta se sigue enviando después de que termina el pedido.
            conn = sqlite3.connect(ruta, timeout=30)
            try:
                for recibido, payload in conn.execute(consulta, params):
                    evento = {**json.loads(payload), "recibido_en": recibido}
                    if en_rango(evento, recibido):
                        yield evento
            finally:
                conn.close()

        def generar_csv():
            buffer = io.StringIO()
            escritor = csv.writer(buffer, lineterminator="\r\n")
            escritor.writerow(COLUMNAS_EXPORT)
            yield "\ufeff" + buffer.getvalue()
            for i, evento in enumerate(filas()):
                buffer.seek(0)
                buffer.truncate()
                escritor.writerow(["" if evento.get(c) is None else
                                   ("true" if evento[c] is True else "false" if evento[c] is False else evento[c])
                                   for c in COLUMNAS_EXPORT])
                yield buffer.getvalue()

        def generar_json():
            yield "[\n"
            primero = True
            for evento in filas():
                yield ("" if primero else ",\n") + json.dumps(evento, ensure_ascii=False, sort_keys=True)
                primero = False
            yield "\n]\n"

        sufijo = "_".join(x.strftime("%Y%m%d") for x in (desde, hasta) if x) or "completo"
        nombre = f"alertar_{paso_id}_{sufijo}.{formato}"
        tipo = "text/csv; charset=utf-8" if formato == "csv" else "application/json; charset=utf-8"
        cuerpo = generar_csv() if formato == "csv" else generar_json()
        return Response(cuerpo, mimetype=tipo.split(";")[0], content_type=tipo,
                        headers={"Content-Disposition": f'attachment; filename="{nombre}"'})

    @app.get("/api/tuneles")
    def listar_tuneles():
        if not autorizado_admin():
            return jsonify(error="no_autorizado"), 401
        rows = db().execute("""
            SELECT t.*, COUNT(e.id) AS total_eventos, MAX(e.recibido_en) AS ultima_recepcion,
                   (SELECT payload FROM eventos WHERE paso_id = t.paso_id
                    ORDER BY secuencia DESC LIMIT 1) AS ultimo_payload
            FROM tuneles t LEFT JOIN eventos e ON e.paso_id = t.paso_id
            GROUP BY t.paso_id ORDER BY t.paso_id ASC""").fetchall()
        resultado = []
        for r in rows:
            codigo = "SIN_DATOS"
            if r["ultimo_payload"]:
                try:
                    codigo = json.loads(r["ultimo_payload"]).get("codigo", "SIN_DATOS")
                except ValueError:
                    pass
            resultado.append({**publico(r), "total_eventos": r["total_eventos"],
                              "ultima_recepcion": r["ultima_recepcion"], "ultimo_codigo": codigo})
        return jsonify(tuneles=resultado)

    @app.post("/api/tuneles")
    def crear_tunel():
        """Genera una clave de dispositivo asociada a una ubicación. La clave se muestra una sola vez."""
        if not autorizado_admin():
            return jsonify(error="no_autorizado"), 401
        body = request.get_json(silent=True) or {}
        nombre = str(body.get("nombre", "")).strip()
        if not nombre or len(nombre) > 60:
            return jsonify(error="nombre_invalido", detalle="El nombre debe tener entre 1 y 60 caracteres."), 400
        try:
            ubicacion, lat, lon = leer_ubicacion(body)
        except ValueError as error:
            return jsonify(error="ubicacion_invalida", detalle=str(error)), 400

        conn = db()
        conn.execute("BEGIN IMMEDIATE")
        try:
            count = conn.execute("SELECT COUNT(*) FROM tuneles").fetchone()[0]
            paso_id = str(body.get("paso_id", "")).strip().lower() or f"tunel-{count+1:02d}"
            if not re.fullmatch(r"[a-z0-9_-]{1,80}", paso_id):
                conn.rollback()
                return jsonify(error="paso_id_invalido", detalle="Usar 1-80 caracteres alfanuméricos, guion o guion bajo."), 400
            dispositivo_id = str(body.get("dispositivo_id", "")).strip().lower()
            if not dispositivo_id:
                num = re.sub(r"[^0-9]", "", paso_id) or str(count + 1)
                dispositivo_id = f"esp32-{int(num):02d}"
            if not re.fullmatch(r"[a-z0-9_-]{1,80}", dispositivo_id):
                conn.rollback()
                return jsonify(error="dispositivo_id_invalido"), 400
            if conn.execute("SELECT 1 FROM tuneles WHERE paso_id = ? OR dispositivo_id = ?",
                            (paso_id, dispositivo_id)).fetchone():
                conn.rollback()
                return jsonify(error="ya_existe", detalle="El ID de túnel o dispositivo ya está en uso."), 409
            clave = secrets.token_urlsafe(24)
            ahora = datetime.now(timezone.utc).isoformat()
            conn.execute(
                "INSERT INTO tuneles (paso_id, nombre, dispositivo_id, api_key, creado_en, ubicacion, latitud, longitud)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (paso_id, nombre, dispositivo_id, app.extensions["alertar_hash"](clave), ahora, ubicacion, lat, lon))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return jsonify(paso_id=paso_id, nombre=nombre, dispositivo_id=dispositivo_id, api_key=clave,
                       creado_en=ahora, ubicacion=ubicacion, latitud=lat, longitud=lon), 201

    @app.patch("/api/tuneles/<paso_id>")
    def editar_tunel(paso_id):
        if not autorizado_admin():
            return jsonify(error="no_autorizado"), 401
        body = request.get_json(silent=True) or {}
        actual = db().execute("SELECT * FROM tuneles WHERE paso_id = ?", (paso_id,)).fetchone()
        if not actual:
            return jsonify(error="tunel_no_encontrado"), 404
        nombre = str(body["nombre"]).strip() if "nombre" in body else actual["nombre"]
        if not nombre or len(nombre) > 60:
            return jsonify(error="nombre_invalido"), 400
        try:
            if {"ubicacion", "latitud", "longitud"} & set(body):
                ubicacion, lat, lon = leer_ubicacion(body)
            else:
                ubicacion, lat, lon = actual["ubicacion"], actual["latitud"], actual["longitud"]
        except ValueError as error:
            return jsonify(error="ubicacion_invalida", detalle=str(error)), 400
        with db() as conn:
            conn.execute("UPDATE tuneles SET nombre=?, ubicacion=?, latitud=?, longitud=? WHERE paso_id=?",
                         (nombre, ubicacion, lat, lon, paso_id))
        return jsonify(paso_id=paso_id, nombre=nombre, ubicacion=ubicacion, latitud=lat, longitud=lon)

    @app.post("/api/tuneles/<paso_id>/clave")
    def rotar_clave_tunel(paso_id):
        """Reemplaza la clave del dispositivo (p. ej. si se perdió). La anterior deja de funcionar."""
        if not autorizado_admin():
            return jsonify(error="no_autorizado"), 401
        clave = secrets.token_urlsafe(24)
        with db() as conn:
            cur = conn.execute("UPDATE tuneles SET api_key=? WHERE paso_id=?",
                               (app.extensions["alertar_hash"](clave), paso_id))
        if not cur.rowcount:
            return jsonify(error="tunel_no_encontrado"), 404
        return jsonify(paso_id=paso_id, api_key=clave)

    @app.delete("/api/tuneles/<paso_id>")
    def eliminar_tunel(paso_id):
        if not autorizado_admin():
            return jsonify(error="no_autorizado"), 401
        if paso_id == "tunel-01":
            return jsonify(error="no_permitido", detalle="tunel-01 es el túnel base y no se elimina."), 400
        tunel = db().execute("SELECT dispositivo_id FROM tuneles WHERE paso_id = ?", (paso_id,)).fetchone()
        if not tunel:
            return jsonify(error="tunel_no_encontrado"), 404
        with db() as conn:
            conn.execute("DELETE FROM eventos WHERE paso_id = ?", (paso_id,))
            conn.execute("DELETE FROM instalaciones WHERE dispositivo_id = ?", (tunel["dispositivo_id"],))
            conn.execute("DELETE FROM tuneles WHERE paso_id = ?", (paso_id,))
        return jsonify(eliminado=True, paso_id=paso_id), 200

    def generar_evento_simulado(tunel, tipo="normal"):
        dispositivo_id = tunel["dispositivo_id"]
        paso_id = tunel["paso_id"]
        conn = db()
        conn.execute("BEGIN IMMEDIATE")
        last_seq = conn.execute(
            "SELECT COALESCE(MAX(secuencia), 0) FROM eventos WHERE dispositivo_id = ?",
            (dispositivo_id,)
        ).fetchone()[0]
        seq = last_seq + 1
        now_dt = datetime.now(timezone.utc)
        now_iso = now_dt.isoformat()

        if tipo == "agua":
            codigo = "ERR-001"
            diagnostico = f"Inundacion critica en {tunel['nombre']} - Paso cerrado"
            agua_activa = True
            agua_pendiente = False
            c1_valido = True
            c1_obs = 0
            c2_valido = True
            c2_obs = 0
        elif tipo == "obstruccion":
            codigo = "INF-001"
            diagnostico = f"Vehiculo con exceso de galibo detenido en {tunel['nombre']}"
            agua_activa = False
            agua_pendiente = False
            c1_valido = True
            c1_obs = 185.0
            c2_valido = True
            c2_obs = 0
        elif tipo == "falla":
            codigo = "ERR-002"
            diagnostico = f"Falla de lectura sensor carril 2 en {tunel['nombre']}"
            agua_activa = False
            agua_pendiente = False
            c1_valido = True
            c1_obs = 0
            c2_valido = False
            c2_obs = None
        else:
            codigo = "OK-001"
            diagnostico = f"Paso habilitado - Situacion normal en {tunel['nombre']}"
            agua_activa = False
            agua_pendiente = False
            c1_valido = True
            c1_obs = 0
            c2_valido = True
            c2_obs = 0

        event_data = {
            "version": 1,
            "evento_id": f"{dispositivo_id}-{seq}-{secrets.token_hex(4)}",
            "dispositivo_id": dispositivo_id,
            "paso_id": paso_id,
            "arranque_id": f"arranque-sim-{dispositivo_id}",
            "secuencia": seq,
            "uptime_ms": 15000 + seq * 5000,
            "medido_en": now_iso,
            "codigo": codigo,
            "diagnostico": diagnostico,
            "sensor1_valido": c1_valido,
            "sensor2_valido": c2_valido,
            "obstruccion_carril1_cm": c1_obs,
            "obstruccion_carril2_cm": c2_obs,
            "agua_activa": agua_activa,
            "agua_pendiente": agua_pendiente
        }
        payload = json.dumps(event_data, sort_keys=True, ensure_ascii=False)
        conn.execute(
            "INSERT INTO eventos (evento_id, dispositivo_id, paso_id, secuencia, recibido_en, payload) VALUES (?, ?, ?, ?, ?, ?)",
            (event_data["evento_id"], dispositivo_id, paso_id, seq, now_iso, payload)
        )
        conn.commit()
        return event_data

    @app.post("/api/simulador/evento")
    def simular_evento():
        if not app.config["ENABLE_SIMULATOR"]:
            return jsonify(error="simulador_deshabilitado"), 404
        if not autorizado_admin():
            return jsonify(error="no_autorizado"), 401
        body = request.get_json(silent=True) or {}
        paso_id = body.get("paso_id", "tunel-01")
        tipo = body.get("tipo", "normal")
        tunel = db().execute("SELECT * FROM tuneles WHERE paso_id = ?", (paso_id,)).fetchone()
        if not tunel:
            return jsonify(error="tunel_no_encontrado"), 404
        ev = generar_evento_simulado(tunel, tipo)
        return jsonify(guardado=True, evento=ev), 201

    @app.post("/api/simulador/disparar-todos")
    def simular_todos():
        if not app.config["ENABLE_SIMULATOR"]:
            return jsonify(error="simulador_deshabilitado"), 404
        if not autorizado_admin():
            return jsonify(error="no_autorizado"), 401
        body = request.get_json(silent=True) or {}
        tipo = body.get("tipo", "normal")
        tuneles = db().execute("SELECT * FROM tuneles ORDER BY paso_id ASC").fetchall()
        eventos = [generar_evento_simulado(t, tipo) for t in tuneles]
        return jsonify(guardado=True, cantidad=len(eventos), eventos=eventos), 201
