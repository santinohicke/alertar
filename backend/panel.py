"""Panel y protección de recursos. Sin dependencias fuera de Flask/stdlib."""
import hashlib
import hmac
import secrets
import threading
import time

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
            es_device = igual(key, device)
            ruta_ingesta = request.endpoint in ("receive", "reserve")
            if not es_master and not (es_device and escritura and ruta_ingesta) and not (
                    not escritura and session.get("lector")):
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
        if paso_id not in app.config["DISPOSITIVOS"]:
            return jsonify(error="paso_desconocido"), 404
        response = app.make_response(estado(paso_id))
        snapshot = response.get_json()
        rows = db().execute("SELECT * FROM eventos WHERE paso_id=? ORDER BY secuencia DESC LIMIT 20", (paso_id,)).fetchall()
        # No COUNT(*) ni carga de todo el historial en cada actualización.
        return jsonify(estado=snapshot, eventos=[record(row) for row in rows], intervalo_s=15,
                       vigencia_s=app.config["STALE_SECONDS"])
