"""API local de AlertAR. Ejecutar desde backend con flask --app app run."""

import json
import math
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


def utcnow():
    return datetime.now(timezone.utc)


def db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"], timeout=5)
        g.db.row_factory = sqlite3.Row
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
        DATABASE=str(ROOT / "instance" / "alertar.sqlite3"),
        MAX_CONTENT_LENGTH=16 * 1024,
        STALE_SECONDS=30,
        DISPOSITIVOS={"tunel-01": "esp32-01"},
    )
    if config:
        app.config.update(config)
    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    with app.app_context():
        connection = db()
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
        """)
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

    @app.post("/api/eventos")
    def receive():
        try:
            event = validate(request.get_json())
        except ValueError as error:
            return jsonify(error="evento_invalido", detalle=str(error)), 400
        if app.config["DISPOSITIVOS"].get(event["paso_id"]) != event["dispositivo_id"]:
            return jsonify(error="dispositivo_o_paso_no_registrado"), 400
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

    return app
