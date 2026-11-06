# Implementación de AlertAR

## Componentes

| Componente | Ubicación | Estado |
|---|---|---|
| Sensores, lógica local, LEDs y LCD | `AlertAR-2/src/` | Implementados en la simulación. |
| Wi-Fi, HTTPS, cola LittleFS y reintentos | `AlertAR-2/src/` | Implementados; estabilidad prolongada pendiente. |
| API de eventos, SQLite y panel | `backend/` | Implementados y publicados en el servidor. |
| Estadísticas calculadas en el servidor | `backend/estadisticas.py` | Implementadas; un resumen por paso y rango en lugar del historial completo. |
| Panel: monitoreo, historial, estadísticas, mapa y gestión de pasos | `backend/templates/`, `backend/static/` | Implementado; ver [PANEL.md](PANEL.md). |
| Despliegue en servidor | `deploy/servidor/` | gunicorn como servicio de usuario y Tailscale Funnel en el puerto 8443. |
| Integración con la API FastAPI anterior | `deploy/raspi/gateway.py` | Instalación anterior en la Pi; conserva las rutas anteriores. |
| Límites y watchdog de Tailscale | `deploy/raspi/` | Instalados; los límites de memoria requieren soporte del sistema. |
| Pruebas de lógica, protocolo, API y panel | `tests/`, `backend/tests/` | Disponibles; no sustituyen pruebas físicas o prolongadas. |

La API FastAPI original de la Raspberry Pi no está en este repositorio; solo hace falta para la instalación en la Pi. El adaptador monta el backend Flask en el mismo proceso Uvicorn, conserva las rutas antiguas y almacena los eventos modernos en tablas nuevas sin borrar los registros anteriores.

## Contrato y seguridad

El ESP32 decide el estado sin depender de Internet. Los eventos usan identidad y secuencia persistentes para evitar duplicados y conservar el orden aunque lleguen atrasados. La API separa `medido_en` de `recibido_en`: un dato antiguo o sin hora no se presenta como estado vigente para circular.

El panel exige autenticación en producción. La clave administrativa queda en el servidor; cada paso tiene su propia clave de dispositivo, guardada como hash, que solo permite ingesta y reserva para ese paso. La [URL publicada](https://homebase.tail5a3b96.ts.net:8443/) puede compartirse sin publicar las claves. Los archivos de credenciales, bases SQLite, respaldos y firmware compilado están excluidos de Git.

## Alcance comprobado y pendiente

En noviembre de 2026 pasan 44 pruebas Python del backend en `main` (46 en `demo`) (API, panel, estadísticas, borrado y límites). Con 252.000 eventos en el servidor, una prueba de carga de 20 paneles y 10 ESP32 durante 60 s no tuvo rechazos (detalle en [deploy/servidor/README.md](deploy/servidor/README.md)).

Antes de la primera publicación se aprobaron 21 pruebas Python, pruebas C++ de cola/protocolo y 2700 combinaciones de lógica, y se comprobó el panel publicado. El endpoint `/health` respondió HTTP 200 el 25/09/2026. Estas comprobaciones no certifican continuidad de la conexión Wokwi → HTTPS → Pi. Continúan pendientes la estabilidad de reenvío, el incidente de watchdog en un reinicio del simulador, los límites efectivos de memoria de la Pi y la validación física de sensores, actuadores y alimentación.

Ver [PANEL.md](PANEL.md), [CONECTIVIDAD.md](CONECTIVIDAD.md), [PANEL_RASPBERRY.md](PANEL_RASPBERRY.md) y [tabla_logica.md](tabla_logica.md) para más detalle.
