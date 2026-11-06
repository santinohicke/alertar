# Instalación en la Raspberry Pi

El servicio publicado de AlertAR ahora corre en un servidor ([despliegue.md](despliegue.md)). Este documento describe la instalación anterior en la Raspberry Pi, que sigue disponible para un despliegue chico. El funcionamiento del panel está en [panel.md](panel.md).

En la Pi, el panel Flask y la API moderna se sirven mediante HTTPS y Tailscale Funnel. `deploy/raspi/gateway.py` los monta junto a la API FastAPI que ya existía en esa Pi, dentro de un único proceso Uvicorn. El código de esa API anterior no está incluido en el repositorio. Sus rutas y registros antiguos se conservan; los eventos del ESP32 se guardan en tablas nuevas de la misma base SQLite.

## Permisos

- En producción, `ALERTAR_REQUIRE_AUTH=1` protege el panel y las rutas API. La clave administrativa permite lectura y gestión; la clave de dispositivo solo permite ingesta y reserva. Las sesiones de lectura usan cookie `Secure`, `HttpOnly` y `SameSite=Strict`, y los formularios usan CSRF.

## Despliegue específico

`deploy/raspi/instalar.py` fue escrito para la Pi existente: espera la API antigua, su servicio `alertar-api` y su configuración privada. Antes de instalar, crea un respaldo de código, configuración y SQLite; genera una clave de dispositivo separada y verifica el servicio después del reinicio. No es un instalador genérico para una Raspberry nueva. Los archivos privados y respaldos permanecen fuera de Git.

`deploy/raspi/limites.conf` configura un proceso Uvicorn, límites de concurrencia, CPU, tareas y memoria, y un keep-alive de 30 segundos para instalaciones nuevas. También fija los límites de ritmo originales de la Pi (`ALERTAR_LIMITE_INGESTA=2,4`, `ALERTAR_LIMITE_LECTURA=4,8`, `ALERTAR_LIMITE_ADMIN=0.5,6`, `ALERTAR_CONCURRENCIA=4`), más bajos que los valores por defecto del código, que están pensados para un servidor. Para un servicio ya desplegado, el plazo se aplica reinstalando con `deploy/raspi/instalar.py`, que copia `limites.conf`; la prueba posterior no está confirmada. En la última comprobación de la Pi, CPU y tareas tenían límites efectivos; los límites de RAM no se aplicaban porque el controlador de memoria de cgroups estaba deshabilitado en el arranque.

El watchdog de Tailscale se instaló para intentar recuperación tras tres fallas consecutivas del mapa de red, con un intervalo mínimo de 15 minutos entre reinicios. La política y la operación están en [WATCHDOG_TAILSCALE.md](../deploy/raspi/WATCHDOG_TAILSCALE.md).

## Validación

El 19/09/2026 se comprobaron el servicio activo, `/health` 200, `/login` 200 y `/api/eventos` sin clave 401. El 25/09/2026 `/health` volvió a responder 200. Las pruebas aisladas de API y panel pasaron, y hubo entregas de eventos por HTTPS desde Wokwi, pero la continuidad prolongada de esa ruta aún no está validada. Tampoco se ha completado la validación eléctrica y ambiental con hardware real.

Para el contrato de la API, ver [api.md](api.md). Para los límites del firmware y el reenvío, ver [conectividad.md](conectividad.md).
