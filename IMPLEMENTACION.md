# Implementación de AlertAR

## Componentes

| Componente | Ubicación | Estado |
|---|---|---|
| Sensores, lógica local, LEDs y LCD | `AlertAR-2/src/` | Implementados en la simulación. |
| Wi-Fi, HTTPS, cola LittleFS y reintentos | `AlertAR-2/src/` | Implementados; estabilidad prolongada pendiente. |
| API de eventos, SQLite y panel | `backend/` | Implementados y publicados en la Pi. |
| Integración con la API FastAPI anterior | `deploy/raspi/gateway.py` | Instalación específica de la Pi existente; conserva las rutas anteriores. |
| Límites y watchdog de Tailscale | `deploy/raspi/` | Instalados; los límites de memoria requieren soporte del sistema. |
| Pruebas de lógica, protocolo, API y panel | `tests/`, `backend/tests/` | Disponibles; no sustituyen pruebas físicas o prolongadas. |

La API FastAPI original de la Raspberry Pi no está en este repositorio. El adaptador monta el backend Flask en el mismo proceso Uvicorn, conserva las rutas antiguas y almacena los eventos modernos en tablas nuevas sin borrar los registros anteriores.

## Contrato y seguridad

El ESP32 decide el estado sin depender de Internet. Los eventos usan identidad y secuencia persistentes para evitar duplicados y conservar el orden aunque lleguen atrasados. La API separa `medido_en` de `recibido_en`: un dato antiguo o sin hora no se presenta como estado vigente para circular.

El panel exige autenticación en producción. La clave administrativa queda en el servidor; una clave distinta permite al firmware únicamente ingesta y reserva. La URL pública del panel puede compartirse mediante proxy HTTPS seguro sin publicar las claves. Los archivos de credenciales, bases SQLite, respaldos y firmware compilado están excluidos de Git.

## Alcance comprobado y pendiente

Antes de esta publicación se aprobaron 21 pruebas Python, pruebas C++ de cola/protocolo y 2700 combinaciones de lógica, y se comprobó el panel publicado. El endpoint `/health` respondió HTTP 200 el 25/09/2026. Estas comprobaciones no certifican continuidad de la conexión Wokwi → HTTPS → Pi. Continúan pendientes la estabilidad de reenvío, el incidente de watchdog en un reinicio del simulador, los límites efectivos de memoria de la Pi y la validación física de sensores, actuadores y alimentación.

Ver [CONECTIVIDAD.md](CONECTIVIDAD.md), [PANEL_RASPBERRY.md](PANEL_RASPBERRY.md) y [tabla_logica.md](tabla_logica.md) para más detalle.
