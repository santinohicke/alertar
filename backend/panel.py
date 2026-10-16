"""Panel y protección de recursos. Sin dependencias fuera de Flask/stdlib."""
import hashlib
import hmac
import secrets
import threading
import time

import json
import re
from datetime import datetime, timezone

from flask import g, jsonify, redirect, render_template, request, session, url_for


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
    # Sin diccionarios por IP que crezcan indefinidamente. Límites globales por proceso.
    cubos = {"ingesta": Cubo(2, 4), "lectura": Cubo(4, 8), "login": Cubo(0.1, 5)}
    activos = threading.BoundedSemaphore(4)
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

            tunel_auth = None
            if key:
                try:
                    tunel_auth = db().execute("SELECT * FROM tuneles WHERE api_key = ?", (key,)).fetchone()
                except Exception:
                    tunel_auth = None
                if not tunel_auth and device and igual(key, device):
                    try:
                        tunel_auth = db().execute("SELECT * FROM tuneles WHERE paso_id = 'tunel-01'").fetchone()
                    except Exception:
                        pass

            ruta_ingesta = request.endpoint in ("receive", "reserve")
            if es_master:
                g.es_master = True
            elif tunel_auth and escritura and ruta_ingesta:
                g.auth_paso_id = tunel_auth["paso_id"]
                g.auth_device_id = tunel_auth["dispositivo_id"]
            elif not escritura and session.get("lector"):
                pass
            elif escritura and session.get("lector") and request.endpoint in (
                    "crear_tunel", "eliminar_tunel", "simular_evento", "simular_todos"):
                pass
            else:
                return jsonify(error="no_autorizado"), 401
        if request.endpoint == "login" and request.method == "POST":
            tipo = "login"
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

    @app.get("/api/tuneles")
    def listar_tuneles():
        if required and not session.get("lector") and not getattr(g, "es_master", False):
            return jsonify(error="no_autorizado"), 401
        rows = db().execute("SELECT * FROM tuneles ORDER BY paso_id ASC").fetchall()
        resultado = []
        for r in rows:
            last_ev = db().execute(
                "SELECT * FROM eventos WHERE paso_id = ? ORDER BY secuencia DESC LIMIT 1",
                (r["paso_id"],)
            ).fetchone()
            last_rec = db().execute(
                "SELECT MAX(recibido_en) FROM eventos WHERE paso_id = ?",
                (r["paso_id"],)
            ).fetchone()[0]
            ultimo_codigo = "SIN_DATOS"
            if last_ev:
                try:
                    ultimo_codigo = json.loads(last_ev["payload"]).get("codigo", "SIN_DATOS")
                except Exception:
                    pass
            total_eventos = db().execute(
                "SELECT COUNT(*) FROM eventos WHERE paso_id = ?",
                (r["paso_id"],)
            ).fetchone()[0]
            item = {
                "paso_id": r["paso_id"],
                "nombre": r["nombre"],
                "dispositivo_id": r["dispositivo_id"],
                "creado_en": r["creado_en"],
                "total_eventos": total_eventos,
                "ultima_recepcion": last_rec,
                "ultimo_codigo": ultimo_codigo
            }
            if getattr(g, "es_master", False):
                item["api_key"] = r["api_key"]
            resultado.append(item)
        return jsonify(tuneles=resultado)

    @app.post("/api/tuneles")
    def crear_tunel():
        if required and not session.get("lector") and not getattr(g, "es_master", False):
            return jsonify(error="no_autorizado"), 401
        body = request.get_json(silent=True, force=True) or {}
        nombre = str(body.get("nombre", "")).strip()
        if not nombre or len(nombre) > 60:
            return jsonify(error="nombre_invalido", detalle="El nombre debe tener entre 1 y 60 caracteres."), 400

        paso_id = str(body.get("paso_id", "")).strip().lower()
        count = db().execute("SELECT COUNT(*) FROM tuneles").fetchone()[0]
        if not paso_id:
            paso_id = f"tunel-{count+1:02d}"
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", paso_id):
            return jsonify(error="paso_id_invalido", detalle="Usar 1-80 caracteres alfanuméricos, guion o guion bajo."), 400

        dispositivo_id = str(body.get("dispositivo_id", "")).strip().lower()
        if not dispositivo_id:
            num = re.sub(r'[^0-9]', '', paso_id) or str(count+1)
            dispositivo_id = f"esp32-{int(num):02d}"
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", dispositivo_id):
            return jsonify(error="dispositivo_id_invalido"), 400

        existente = db().execute(
            "SELECT paso_id FROM tuneles WHERE paso_id = ? OR dispositivo_id = ?",
            (paso_id, dispositivo_id)
        ).fetchone()
        if existente:
            return jsonify(error="ya_existe", detalle="El ID de túnel o dispositivo ya está en uso."), 409

        nueva_key = secrets.token_urlsafe(24)
        ahora = datetime.now(timezone.utc).isoformat()
        with db() as conn:
            conn.execute(
                "INSERT INTO tuneles (paso_id, nombre, dispositivo_id, api_key, creado_en) VALUES (?, ?, ?, ?, ?)",
                (paso_id, nombre, dispositivo_id, nueva_key, ahora)
            )
        return jsonify(
            paso_id=paso_id,
            nombre=nombre,
            dispositivo_id=dispositivo_id,
            api_key=nueva_key,
            creado_en=ahora
        ), 201

    @app.delete("/api/tuneles/<paso_id>")
    def eliminar_tunel(paso_id):
        if required and not session.get("lector") and not getattr(g, "es_master", False):
            return jsonify(error="no_autorizado"), 401
        total = db().execute("SELECT COUNT(*) FROM tuneles").fetchone()[0]
        if total <= 1:
            return jsonify(error="no_permitido", detalle="Debe haber al menos un túnel activo."), 400
        with db() as conn:
            conn.execute("DELETE FROM tuneles WHERE paso_id = ?", (paso_id,))
        return jsonify(eliminado=True, paso_id=paso_id), 200

    def generar_evento_simulado(tunel, tipo="normal"):
        dispositivo_id = tunel["dispositivo_id"]
        paso_id = tunel["paso_id"]
        last_seq = db().execute(
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
        with db() as conn:
            conn.execute(
                "INSERT INTO eventos (evento_id, dispositivo_id, paso_id, secuencia, recibido_en, payload) VALUES (?, ?, ?, ?, ?, ?)",
                (event_data["evento_id"], dispositivo_id, paso_id, seq, now_iso, payload)
            )
        return event_data

    @app.post("/api/simulador/evento")
    def simular_evento():
        if required and not session.get("lector") and not getattr(g, "es_master", False):
            return jsonify(error="no_autorizado"), 401
        body = request.get_json(silent=True, force=True) or {}
        paso_id = body.get("paso_id", "tunel-01")
        tipo = body.get("tipo", "normal")
        tunel = db().execute("SELECT * FROM tuneles WHERE paso_id = ?", (paso_id,)).fetchone()
        if not tunel:
            return jsonify(error="tunel_no_encontrado"), 404
        ev = generar_evento_simulado(tunel, tipo)
        return jsonify(guardado=True, evento=ev), 201

    @app.post("/api/simulador/disparar-todos")
    def simular_todos():
        if required and not session.get("lector") and not getattr(g, "es_master", False):
            return jsonify(error="no_autorizado"), 401
        body = request.get_json(silent=True, force=True) or {}
        tipo = body.get("tipo", "normal")
        tuneles = db().execute("SELECT * FROM tuneles ORDER BY paso_id ASC").fetchall()
        eventos = [generar_evento_simulado(t, tipo) for t in tuneles]
        return jsonify(guardado=True, cantidad=len(eventos), eventos=eventos), 201
