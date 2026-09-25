"""Un proceso Uvicorn: API existente + Flask. No reemplaza app.py ni mediciones."""
import hmac
import os
import sqlite3
from contextlib import asynccontextmanager, contextmanager, closing

import anyio
from a2wsgi import WSGIMiddleware
from fastapi import HTTPException
from starlette.responses import JSONResponse
import app as legacy
from alertar_web.app import create_app
from alertar_web.panel import Cubo


@contextmanager
def conexion_cerrada():
    # sqlite3.Connection como context manager NO cierra la conexión por sí sola.
    with closing(sqlite3.connect(legacy.DB_PATH, timeout=1.5)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA cache_size=-1024")
        conn.execute("PRAGMA synchronous=FULL")
        with conn:
            yield conn


def validar_clave(value):
    if not legacy.API_KEY or not hmac.compare_digest((value or "").encode(), legacy.API_KEY.encode()):
        raise HTTPException(status_code=401, detail="API key inválida")


legacy.conectar_db = conexion_cerrada
legacy.validar_api_key = validar_clave
original_lifespan = legacy.app.router.lifespan_context


@asynccontextmanager
async def lifespan(application):
    anyio.to_thread.current_default_thread_limiter().total_tokens = 2
    async with original_lifespan(application):
        yield


legacy.app.router.lifespan_context = lifespan
web = create_app({"DATABASE": str(legacy.DB_PATH), "REQUIRE_AUTH":True,
                  "SESSION_COOKIE_SECURE":True})
legacy.app.mount("/", WSGIMiddleware(web, workers=2, send_queue_size=2))


class Recursos:
    """Límite de cuerpo también para la API antigua; sin colas crecientes."""
    def __init__(self, app):
        self.app = app
        self.escrituras = Cubo(2, 4)
        self.lecturas = Cubo(4, 8)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        antiguo = scope["path"].startswith("/api/v1/")
        if antiguo:
            headers = dict(scope.get("headers", []))
            value = headers.get(b"x-api-key", b"")
            if not legacy.API_KEY or not hmac.compare_digest(value, legacy.API_KEY.encode()):
                return await JSONResponse({"error":"no_autorizado"}, status_code=401)(scope, receive, send)
            cubo = self.lecturas if scope["method"] in ("GET","HEAD") else self.escrituras
            if not cubo.tomar():
                return await JSONResponse({"error":"ritmo_excedido"}, status_code=429,
                                          headers={"Retry-After":"5"})(scope, receive, send)
        if scope["method"] in ("POST", "PUT", "PATCH"):
            body = bytearray()
            with anyio.move_on_after(8) as timeout:
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    chunk = message.get("body", b"")
                    if len(body) + len(chunk) > 16384:
                        return await JSONResponse({"error":"cuerpo_excesivo"}, status_code=413)(scope, receive, send)
                    body.extend(chunk)
                    if not message.get("more_body", False):
                        break
            if timeout.cancel_called:
                return await JSONResponse({"error":"tiempo_excedido"}, status_code=408)(scope, receive, send)
            delivered = False
            async def replay():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type":"http.request", "body":bytes(body), "more_body":False}
                return await receive()
            return await self.app(scope, replay, send)
        return await self.app(scope, receive, send)


app = Recursos(legacy.app)
