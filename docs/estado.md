# Estado del proyecto

## Componentes

| Componente | Ubicación | Estado |
|---|---|---|
| Sensores, lógica local, LEDs y LCD | `AlertAR-2/src/` | Implementados y probados en la simulación de Wokwi |
| Wi-Fi, NTP, HTTPS, cola en LittleFS y reintentos | `AlertAR-2/src/` | Implementados; entregas continuas observadas, sin validación prolongada formal |
| API de eventos, reservas y SQLite | `backend/app.py` | Implementada y publicada en el servidor |
| Autenticación, claves por paso, límites de ritmo | `backend/panel.py` | Implementados |
| Estadísticas y exportación en el servidor | `backend/estadisticas.py`, `backend/panel.py` | Implementadas |
| Panel: monitoreo, historial, estadísticas, mapa, alta y baja de pasos | `backend/templates/`, `backend/static/` | Implementado; ver [panel.md](panel.md) |
| Despliegue en servidor | `deploy/servidor/` | gunicorn como servicio de usuario y Tailscale Funnel en el puerto 8443 |
| Instalación en Raspberry Pi | `deploy/raspi/` | Instalación anterior, todavía disponible; ver [raspberry.md](raspberry.md) |
| Pruebas | `tests/`, `backend/tests/` | Disponibles; no reemplazan pruebas físicas ni prolongadas |

## Comprobado

- **Noviembre de 2026:** 47 pruebas del backend aprobadas en `main` (49 en `demo`). Con 252.000 eventos en el servidor, una prueba de carga de 20 paneles y 10 ESP32 durante 60 s no tuvo rechazos; la exportación completa de un paso (84.000 eventos, 19 MB) tarda unos 3 s ([despliegue.md](despliegue.md#capacidad-medida)). Entregas continuas Wokwi → HTTPS → servidor con el panel en vivo.
- **Septiembre de 2026:** 21 pruebas Python, pruebas C++ de cola y protocolo y 2.700 combinaciones de lógica aprobadas; panel publicado en la Raspberry Pi con `/health` 200.

## Pendiente

- Validación prolongada de la comunicación Wokwi → HTTPS → servidor y del comportamiento de la cola con cortes largos.
- Un reinicio del simulador con aviso de watchdog observado en septiembre.
- Validación física de sensores, actuadores y alimentación en hardware real.
- En la Raspberry Pi, los límites de memoria de systemd no se aplicaban (controlador de memoria deshabilitado en el arranque).

Ver [arquitectura.md](arquitectura.md) para el recorrido completo de los datos.
