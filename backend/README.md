# Backend y panel de AlertAR

| Archivo | Contenido |
|---|---|
| `app.py` | Configuración, esquema SQLite, contrato y validación de eventos, ingesta, reservas, estado e historial |
| `panel.py` | Autenticación y sesión, límites de ritmo, cabeceras de seguridad, panel, gestión de pasos, estadísticas y exportación |
| `estadisticas.py` | Cálculo del resumen de estadísticas por paso y rango |
| `templates/`, `static/` | Panel web (HTML, CSS y JS sin dependencias externas) |
| `simulador.py` | Simulador de telemetría por línea de comandos |
| `tests/` | Pruebas de la API, el panel, las estadísticas, la exportación y los límites |

Cómo funciona cada parte: [API y almacenamiento](../docs/api.md), [seguridad](../docs/seguridad.md), [panel](../docs/panel.md). Despliegue en un servidor: [despliegue](../docs/despliegue.md).

## Ejecutar en desarrollo

Desde la raíz del repositorio:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
cd backend
.venv/bin/flask --app app run --host=127.0.0.1 --port=5001
```

La aplicación crea las tablas al iniciar, sin borrar datos. Por defecto la base queda en `backend/instance/alertar.sqlite3`, ignorada por Git. En este modo **no hay autenticación** y solo escucha en `127.0.0.1`: no publicarlo en Internet. Wokwi puede enviar a `http://host.wokwi.internal:5001` con una configuración local adecuada.

## Variables de entorno

| Variable | Uso |
| --- | --- |
| `ALERTAR_REQUIRE_AUTH` | `1` exige autenticación (obligatorio al publicar) |
| `ALERTAR_API_KEY` | Clave administrativa y contraseña del panel, mínimo 24 caracteres |
| `ALERTAR_DEVICE_KEY` | Clave inicial de `tunel-01`, usada solo al crear la base; si falta, se genera una aleatoria. Regenerar la clave desde el panel la revoca. Las demás claves se crean desde el panel |
| `ALERTAR_DATABASE` | Ruta de la base SQLite |
| `ALERTAR_LIMITE_INGESTA`, `ALERTAR_LIMITE_LECTURA`, `ALERTAR_LIMITE_ADMIN`, `ALERTAR_LIMITE_LOGIN` | Límites de ritmo como `ritmo,ráfaga`; valores en [api.md](../docs/api.md#límites-de-ritmo) |
| `ALERTAR_CONCURRENCIA` | Pedidos atendidos a la vez (por defecto 16) |
| `ALERTAR_ENABLE_SIMULATOR` | `1` habilita `/api/simulador/*`, que inserta eventos falsos sin validar; solo para desarrollo |

## Probar a mano

```bash
curl http://127.0.0.1:5001/health
curl -i -H 'Content-Type: application/json' --data-binary @examples/evento.json http://127.0.0.1:5001/api/eventos
curl http://127.0.0.1:5001/api/pasos/tunel-01/estado
curl 'http://127.0.0.1:5001/api/pasos/tunel-01/historial?limite=50&offset=0'
curl 'http://127.0.0.1:5001/api/pasos/tunel-01/estadisticas?rango=24h'
curl -o eventos.csv 'http://127.0.0.1:5001/api/pasos/tunel-01/exportar?formato=csv'
```

El primer `POST` devuelve 201; repetirlo devuelve 200 con `duplicado: true`. El ejemplo usa hora desconocida (`medido_en: null`), así que no se muestra como una medición vigente. Con autenticación, agregar `-H 'X-API-Key: …'`.

## Pruebas

```bash
cd backend
.venv/bin/python -m unittest discover -s tests -v
```

Son 48 y usan bases temporales en `backend/.test-tmp`, sin tocar la base de uso normal. Cubren persistencia, contrato, duplicados y conflictos, actualidad, autenticación y separación de permisos, CSRF, panel, cálculo y endpoint de estadísticas, exportación por rango, borrado de pasos y límites de ritmo. No reemplazan una prueba prolongada Wokwi → HTTPS → servidor.
