"""API local de AlertAR. Ejecutar desde backend con flask --app app run."""

import hashlib
import json
import math
import secrets
import os
import re
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path

from flask import Flask, current_app, g, jsonify, request
from werkzeug.exceptions import HTTPException

ROOT = Path(__file__).resolve().parent
CODES = {"OK-001", "INF-001", *(f"ERR-{i:03}" for i in range(1, 8))}
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
FIELDS = {
    "version", "evento_id", "dispositivo_id", "paso_id", "arranque_id",
    "secuencia", "uptime_ms", "medido_en", "codigo", "diagnostico",
    "obstruccion_carril1_cm", "obstruccion_carril2_cm", "sensor1_valido",
    "sensor2_valido", "agua_activa", "agua_pendiente",
}


def hash_clave(clave):
    """Las claves de dispositivo se guardan solo como hash; la clave en claro se muestra una vez."""
    return "sha256:" + hashlib.sha256(clave.encode()).hexdigest()


def _limite(variable, defecto):
    """Lee "ritmo,ráfaga" desde el entorno; si falta o es inválido usa el valor por defecto."""
    texto = os.environ.get(variable, "")
    try:
        ritmo, rafaga = (float(x) for x in texto.split(","))
        if ritmo > 0 and rafaga >= 1:
            return ritmo, rafaga
    except ValueError:
        pass
    return defecto


def utcnow():
    return datetime.now(timezone.utc)


def db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"], timeout=1.5)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA cache_size=-1024")
        g.db.execute("PRAGMA synchronous=FULL")
    return g.db


def validate(event):
    if not isinstance(event, dict) or set(event) != FIELDS:
        raise ValueError("El objeto debe contener exactamente los campos del contrato v1.")
    if type(event["version"]) is not int or event["version"] != 1:
        raise ValueError("version debe ser 1.")
    for name in ("evento_id", "dispositivo_id", "paso_id", "arranque_id"):
        if not isinstance(event[name], str) or not IDENTIFIER.fullmatch(event[name]):
            raise ValueError(f"{name}: usar 1–80 letras ASCII, números, guion o guion bajo.")
    for name in ("secuencia", "uptime_ms"):
        if type(event[name]) is not int or not 0 <= event[name] <= 2**63 - 1:
            raise ValueError(f"{name} debe ser un entero no negativo de 64 bits con signo.")
    if not isinstance(event["codigo"], str) or event["codigo"] not in CODES:
        raise ValueError("codigo desconocido.")
    if not isinstance(event["diagnostico"], str) or not 1 <= len(event["diagnostico"].strip()) <= 200:
        raise ValueError("diagnostico debe tener entre 1 y 200 caracteres.")
    for name in ("sensor1_valido", "sensor2_valido", "agua_activa", "agua_pendiente"):
        if type(event[name]) is not bool:
            raise ValueError(f"{name} debe ser booleano.")
    for lane in (1, 2):
        height = event[f"obstruccion_carril{lane}_cm"]
        valid = event[f"sensor{lane}_valido"]
        if not valid:
            if height is not None:
                raise ValueError("Un sensor inválido debe informar altura null.")
        elif type(height) not in (int, float) or not math.isfinite(height) or not 0 <= height <= 398:
            raise ValueError("La altura válida debe estar entre 0 y 398 cm.")
    if event["agua_activa"] and event["agua_pendiente"]:
        raise ValueError("Agua confirmada y pendiente no pueden ser ambas true.")
    measured = event["medido_en"]
    if measured is not None:
        if not isinstance(measured, str) or len(measured) > 40:
            raise ValueError("medido_en debe ser fecha ISO 8601 con zona horaria o null.")
        try:
            parsed = datetime.fromisoformat(measured.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError()
            parsed = parsed.astimezone(timezone.utc)
        except (ValueError, OverflowError):
            raise ValueError("medido_en debe ser fecha ISO 8601 con zona horaria o null.") from None
        if parsed > utcnow() + timedelta(seconds=60):
            raise ValueError("medido_en está más de 60 segundos en el futuro.")
        event["medido_en"] = parsed.isoformat()
    return event


def create_app(config=None):
    app = Flask(__name__)
    app.config.update(
        DATABASE=os.environ.get("ALERTAR_DATABASE", str(ROOT / "instance" / "alertar.sqlite3")),
        MAX_CONTENT_LENGTH=16 * 1024,
        STALE_SECONDS=60,
        DISPOSITIVOS={"tunel-01": "esp32-01"},
        REQUIRE_AUTH=os.environ.get("ALERTAR_REQUIRE_AUTH", "0") == "1",
        API_KEY=os.environ.get("ALERTAR_API_KEY", ""),
        DEVICE_KEY=os.environ.get("ALERTAR_DEVICE_KEY", ""),
        RATE_LIMIT_ENABLED=True,
        # Límites globales por proceso: (pedidos por segundo, ráfaga). Valores pensados para un
        # servidor (decenas de ESP32 y paneles abiertos). En la Raspberry Pi se bajan desde el
        # entorno (deploy/raspi/limites.conf). Formato de las variables: "ritmo,ráfaga".
        RATE_LIMITS={
            "ingesta": _limite("ALERTAR_LIMITE_INGESTA", (20, 60)),
            "lectura": _limite("ALERTAR_LIMITE_LECTURA", (30, 90)),
            "login": _limite("ALERTAR_LIMITE_LOGIN", (0.1, 5)),
            "admin": _limite("ALERTAR_LIMITE_ADMIN", (2, 10)),
        },
        # Pedidos atendidos a la vez; el resto recibe 429 en lugar de acumularse.
        CONCURRENCIA=int(os.environ.get("ALERTAR_CONCURRENCIA", "16")),
        ENABLE_SIMULATOR=os.environ.get("ALERTAR_ENABLE_SIMULATOR", "0") == "1",
        SESSION_COOKIE_SECURE=os.environ.get("ALERTAR_REQUIRE_AUTH", "0") == "1",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Strict",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
    )
    if config:
        app.config.update(config)
    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    with app.app_context():
        connection = db()
        connection.execute("PRAGMA journal_mode=WAL")
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS eventos (
                id INTEGER PRIMARY KEY,
                evento_id TEXT NOT NULL,
                dispositivo_id TEXT NOT NULL,
                paso_id TEXT NOT NULL,
                secuencia INTEGER NOT NULL,
                recibido_en TEXT NOT NULL,
                payload TEXT NOT NULL,
                UNIQUE(dispositivo_id, evento_id),
                UNIQUE(dispositivo_id, secuencia)
            );
            CREATE INDEX IF NOT EXISTS eventos_paso_secuencia
                ON eventos(paso_id, secuencia DESC);
            CREATE INDEX IF NOT EXISTS eventos_paso_recepcion
                ON eventos(paso_id, recibido_en DESC);
            CREATE TABLE IF NOT EXISTS instalaciones (
                dispositivo_id TEXT NOT NULL,
                instalacion_id TEXT NOT NULL,
                base INTEGER NOT NULL,
                tamano INTEGER NOT NULL,
                PRIMARY KEY(dispositivo_id, instalacion_id)
            );
            CREATE TABLE IF NOT EXISTS tuneles (
                paso_id TEXT PRIMARY KEY,
                nombre TEXT NOT NULL,
                dispositivo_id TEXT NOT NULL UNIQUE,
                api_key TEXT NOT NULL UNIQUE,
                creado_en TEXT NOT NULL,
                ubicacion TEXT,
                latitud REAL,
                longitud REAL
            );
        """)
        # Duplicado de eventos_paso_recepcion creado por una versión anterior.
        connection.execute("DROP INDEX IF EXISTS eventos_paso_recibido")
        columnas = {r["name"] for r in connection.execute("PRAGMA table_info(tuneles)")}
        for nombre, tipo in (("ubicacion", "TEXT"), ("latitud", "REAL"), ("longitud", "REAL")):
            if nombre not in columnas:
                connection.execute(f"ALTER TABLE tuneles ADD COLUMN {nombre} {tipo}")
        # Migra claves guardadas en claro por versiones anteriores.
        for fila in connection.execute("SELECT paso_id, api_key FROM tuneles").fetchall():
            if not fila["api_key"].startswith("sha256:"):
                connection.execute("UPDATE tuneles SET api_key=? WHERE paso_id=?",
                                   (hash_clave(fila["api_key"]), fila["paso_id"]))
        tunel = connection.execute("SELECT paso_id FROM tuneles WHERE paso_id='tunel-01'").fetchone()
        if not tunel:
            # Sin clave configurada se genera una aleatoria que nadie conoce; no hay claves por defecto.
            clave = app.config.get("DEVICE_KEY") or secrets.token_urlsafe(32)
            connection.execute(
                "INSERT INTO tuneles (paso_id, nombre, dispositivo_id, api_key, creado_en) VALUES (?, ?, ?, ?, ?)",
                ("tunel-01", "Túnel 01", "esp32-01", hash_clave(clave), utcnow().isoformat())
            )
        connection.commit()
        g.pop("db").close()

    @app.teardown_appcontext
    def close_db(error=None):
        connection = g.pop("db", None)
        if connection is not None:
            connection.close()

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error=error.name, detalle=error.description), error.code

    @app.errorhandler(sqlite3.Error)
    def database_error(error):
        app.logger.error("Error SQLite: %s", error)
        return jsonify(error="base_no_disponible", detalle="Reintentar sin descartar el evento."), 503

    @app.get("/health")
    def health():
        db().execute("SELECT id FROM eventos LIMIT 1").fetchone()
        return jsonify(estado="ok", base_datos="ok")

    def get_dispositivos():
        try:
            rows = db().execute("SELECT paso_id, dispositivo_id FROM tuneles").fetchall()
            if rows:
                return {r["paso_id"]: r["dispositivo_id"] for r in rows}
        except Exception:
            pass
        return current_app.config.get("DISPOSITIVOS", {"tunel-01": "esp32-01"})

    @app.post("/api/eventos")
    def receive():
        try:
            event = validate(request.get_json())
        except ValueError as error:
            return jsonify(error="evento_invalido", detalle=str(error)), 400
        dispositivos = get_dispositivos()
        if dispositivos.get(event["paso_id"]) != event["dispositivo_id"]:
            return jsonify(error="dispositivo_o_paso_no_registrado"), 400
        auth_paso = getattr(g, "auth_paso_id", None)
        if auth_paso and auth_paso != event["paso_id"]:
            return jsonify(error="clave_no_corresponde_a_este_tunel"), 403
        payload = json.dumps(event, sort_keys=True, ensure_ascii=False, allow_nan=False)
        connection = db()
        received = utcnow().isoformat()
        try:
            with connection:
                connection.execute(
                    "INSERT INTO eventos (evento_id, dispositivo_id, paso_id, secuencia, recibido_en, payload) VALUES (?, ?, ?, ?, ?, ?)",
                    (event["evento_id"], event["dispositivo_id"], event["paso_id"], event["secuencia"], received, payload),
                )
        except sqlite3.IntegrityError:
            previous = connection.execute(
                "SELECT payload, recibido_en FROM eventos WHERE dispositivo_id = ? AND evento_id = ?",
                (event["dispositivo_id"], event["evento_id"]),
            ).fetchone()
            if previous is None or previous["payload"] != payload:
                return jsonify(error="conflicto_identidad", detalle="Identificador o secuencia reutilizados con otro evento."), 409
            return jsonify(guardado=True, duplicado=True, evento_id=event["evento_id"], recibido_en=previous["recibido_en"]), 200
        return jsonify(guardado=True, duplicado=False, evento_id=event["evento_id"], recibido_en=received), 201

    @app.post("/api/dispositivos/<dispositivo_id>/reserva")
    def reserve(dispositivo_id):
        """Rango estable por instalación de flash; repetir el POST es idempotente."""
        dispositivos = get_dispositivos()
        if dispositivo_id not in dispositivos.values():
            return jsonify(error="dispositivo_no_registrado"), 404
        auth_dev = getattr(g, "auth_device_id", None)
        if auth_dev and auth_dev != dispositivo_id:
            return jsonify(error="clave_no_corresponde_a_este_dispositivo"), 403
        body = request.get_json()
        if (not isinstance(body, dict) or set(body) != {"instalacion_id"}
                or not isinstance(body["instalacion_id"], str)
                or not re.fullmatch(r"[0-9a-f]{32}", body["instalacion_id"])):
            return jsonify(error="instalacion_invalida"), 400
        connection = db()
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT base, tamano FROM instalaciones WHERE dispositivo_id=? AND instalacion_id=?",
                (dispositivo_id, body["instalacion_id"]),
            ).fetchone()
            if existing:
                base, size = existing
            else:
                last_event = connection.execute(
                    "SELECT COALESCE(MAX(secuencia),-1) FROM eventos WHERE dispositivo_id=?", (dispositivo_id,)
                ).fetchone()[0]
                last_range = connection.execute(
                    "SELECT COALESCE(MAX(base+tamano-1),-1) FROM instalaciones WHERE dispositivo_id=?", (dispositivo_id,)
                ).fetchone()[0]
                base, size = max(last_event, last_range) + 1, 2**32
                if base > 2**63 - 1 - size:
                    return jsonify(error="secuencias_agotadas"), 409
                connection.execute("INSERT INTO instalaciones VALUES (?,?,?,?)",
                                   (dispositivo_id, body["instalacion_id"], base, size))
        return jsonify(instalacion_id=body["instalacion_id"], base=base, tamano=size), 200 if existing else 201

    def record(row):
        return {**json.loads(row["payload"]), "recibido_en": row["recibido_en"]}

    @app.get("/api/pasos/<paso_id>/estado")
    def state(paso_id):
        row = db().execute("SELECT * FROM eventos WHERE paso_id = ? ORDER BY secuencia DESC LIMIT 1", (paso_id,)).fetchone()
        if row is None:
            return jsonify(error="sin_datos", paso_id=paso_id), 404
        last_received = db().execute("SELECT MAX(recibido_en) FROM eventos WHERE paso_id = ?", (paso_id,)).fetchone()[0]
        event = record(row)
        now = utcnow()
        communication_age = max(0, (now - datetime.fromisoformat(last_received)).total_seconds())
        measured = event["medido_en"]
        age = None if measured is None else max(0, (now - datetime.fromisoformat(measured)).total_seconds())
        freshness = "desconocida" if age is None else ("reciente" if age <= app.config["STALE_SECONDS"] else "desactualizada")
        return jsonify(
            paso_id=paso_id, ultimo_estado_conocido=event,
            comunicacion="sin_comunicacion" if communication_age > app.config["STALE_SECONDS"] else "recepcion_reciente",
            ultima_recepcion=last_received, antiguedad_recepcion_s=round(communication_age, 3),
            actualidad_medicion=freshness, antiguedad_medicion_s=None if age is None else round(age, 3),
        )

    @app.get("/api/pasos/<paso_id>/historial")
    def history(paso_id):
        try:
            limit = int(request.args.get("limite", "50"))
            offset = int(request.args.get("offset", "0"))
            if not 1 <= limit <= 200 or not 0 <= offset <= 2**63 - 1:
                raise ValueError()
        except ValueError:
            return jsonify(error="paginacion_invalida"), 400
        rows = db().execute("SELECT * FROM eventos WHERE paso_id = ? ORDER BY secuencia DESC LIMIT ? OFFSET ?", (paso_id, limit, offset)).fetchall()
        total = db().execute("SELECT COUNT(*) FROM eventos WHERE paso_id = ?", (paso_id,)).fetchone()[0]
        return jsonify(paso_id=paso_id, eventos=[record(row) for row in rows], total=total, limite=limit, offset=offset)

    if __package__:
        from .panel import registrar_panel
    else:
        from panel import registrar_panel
    app.extensions["alertar_hash"] = hash_clave
    registrar_panel(app, db, state, record)
    return app
