# Despliegue en un servidor

El servicio publicado de AlertAR corre en un servidor Linux con Tailscale, como servicio de **usuario** de systemd (no necesita `sudo`). gunicorn sirve la app Flask en `127.0.0.1:5001` y Tailscale Funnel la publica por HTTPS en el puerto 8443. Este documento no incluye direcciones, usuarios ni claves del servidor real; esos datos quedan fuera del repositorio.

## Estructura en el servidor

```text
~/alertar/backend/          copia de backend/ de la rama desplegada
~/alertar/venv/             entorno de Python con requirements-lock.txt y gunicorn
~/alertar/data/             base SQLite (permisos 700)
~/alertar/backups/          respaldos previos a cada despliegue
~/.config/alertar/alertar.env   variables privadas (permisos 600)
~/.config/systemd/user/alertar-api.service
```

`alertar.env` define al menos:

```text
ALERTAR_REQUIRE_AUTH=1
ALERTAR_API_KEY=<clave administrativa, mínimo 24 caracteres>
ALERTAR_DEVICE_KEY=<clave inicial de tunel-01>
ALERTAR_DATABASE=<ruta a ~/alertar/data/alertar.sqlite3>
```

Los límites de ritmo y la concurrencia usan los valores por defecto del código (pensados para un servidor). Para cambiarlos, agregar `ALERTAR_LIMITE_*` o `ALERTAR_CONCURRENCIA`; ver [backend/README.md](../../backend/README.md).

## Instalación

1. Crear el entorno e instalar dependencias: `python3 -m venv ~/alertar/venv` y `~/alertar/venv/bin/pip install -r requirements-lock.txt gunicorn`. Si el servidor no tiene `pip` ni acceso a internet, descargar las wheels en otra máquina e instalarlas con `--no-index`.
2. Copiar `backend/` a `~/alertar/backend/` y crear `alertar.env` con permisos 600.
3. Copiar [alertar-api.service](alertar-api.service) a `~/.config/systemd/user/`, y ejecutar `systemctl --user daemon-reload` y `systemctl --user enable --now alertar-api`. Para que el servicio siga corriendo sin sesión abierta: `loginctl enable-linger` (puede requerir un administrador una vez).
4. Publicar con `tailscale funnel --bg --https=8443 http://127.0.0.1:5001`. No usar un puerto que ya publique otro servicio privado.
5. Comprobar `curl https://<servidor>:8443/health` y que `/login` responda 200.

## Actualizar

1. Respaldar el código, la base (con la API de respaldo de SQLite, no copiando el archivo en uso) y la unidad de systemd en `~/alertar/backups/`.
2. Copiar `backend/` de la rama a desplegar, sin `.venv`, `instance` ni cachés (por ejemplo, `rsync -a --delete --exclude .venv --exclude instance --exclude __pycache__`).
3. `systemctl --user restart alertar-api` y comprobar `/health`. El esquema de la base se actualiza solo al iniciar, sin borrar datos.

## Llevarlo a otro servidor

El backend no tiene la dirección del servidor escrita en el código: el panel usa rutas relativas y la *URL de envío* que muestra sale de la dirección con la que se abre. Lo que sí hay que revisar al moverlo:

1. **Requisitos.** Linux con systemd, Python 3.11 o posterior y alguna forma de publicar HTTPS. El certificado debe ser válido, porque con `ALERTAR_REQUIRE_AUTH=1` la cookie de sesión es `Secure` y el panel no funciona por HTTP plano.
2. **Publicación HTTPS.** Con Tailscale, `tailscale funnel --bg --https=<puerto> http://127.0.0.1:5001`; Funnel solo admite los puertos 443, 8443 y 10000, y cada uno publica un único servicio. Con otro proxy (Caddy, nginx), reenviar a `127.0.0.1:5001` y ajustar `--forwarded-allow-ips` en la unidad de systemd a la dirección del proxy. No exponer gunicorn directamente.
3. **Rutas y puerto.** La unidad de [alertar-api.service](alertar-api.service) usa `%h/alertar/...` y el puerto 5001; cambiarlos si el usuario o el puerto son otros. Mantener `--workers 1`.
4. **Variables privadas.** Crear `alertar.env` en el servidor nuevo. Si se copia la base existente, conservar el mismo `ALERTAR_API_KEY` (también es la contraseña del panel) o avisar a quienes lo usan; si se arranca de cero, generar claves nuevas.
5. **Capacidad.** Ajustar `--threads`, `MemoryMax`, `CPUQuota` y, si hace falta, `ALERTAR_CONCURRENCIA` y `ALERTAR_LIMITE_*` al hardware. Para un equipo chico, usar los valores de `deploy/raspi/limites.conf`.
6. **Datos.** Para mudar los datos, copiar la base con la API de respaldo de SQLite (por ejemplo `sqlite3 origen.sqlite3 ".backup destino.sqlite3"`) con el servicio detenido o en un momento sin escrituras. Las claves de dispositivo viajan dentro de la base como hash, así que los ESP32 siguen autenticando sin cambiar su clave.
7. **Firmware de cada ESP32.** En `conectividad_secrets.h` cambiar `ALERTAR_API_URL` y `ALERTAR_RESERVA_API_URL` a la dirección nueva (con su puerto) y volver a compilar. `src/certificado.h` contiene la raíz **ISRG Root X2** de Let's Encrypt, que usan los certificados de Tailscale; si el servidor nuevo usa otra autoridad certificante, reemplazarla por la raíz que corresponda. Nunca desactivar la validación del certificado.
8. **Documentación.** Actualizar la URL publicada en el README, en `CONECTIVIDAD.md` y en la plantilla `conectividad_secrets.example.h`.

Comprobar después: `/health` responde 200, `/login` carga, un `POST /api/eventos` sin clave devuelve 401 y un ESP32 aparece en vivo en el panel.

## Rama a desplegar

Para uso real se despliega `main`. Para presentaciones se puede desplegar `demo` (herramientas en [deploy/demo/README.md](../demo/README.md)), que además guarda y muestra la clave de cada dispositivo. Al volver a `main`, vaciar esa copia con `UPDATE tuneles SET clave_demo = NULL`.

## Capacidad medida

Con 252.000 eventos (14 días de tres pasos), una prueba de 60 s con 20 paneles abiertos y 10 ESP32 enviando su cola a 1 evento/s no tuvo rechazos: monitoreo con mediana de 6 ms, estado de los pasos 74 ms, estadísticas 51 ms (p95 0,9 s sin caché) e ingesta 4 ms. El servicio usó como máximo 137 MB.
