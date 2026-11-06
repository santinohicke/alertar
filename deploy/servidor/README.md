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

## Rama a desplegar

Para uso real se despliega `main`. Para presentaciones se puede desplegar `demo`, que además guarda y muestra la clave de cada dispositivo. Al volver a `main`, vaciar esa copia con `UPDATE tuneles SET clave_demo = NULL`.

## Capacidad medida

Con 252.000 eventos (14 días de tres pasos), una prueba de 60 s con 20 paneles abiertos y 10 ESP32 enviando su cola a 1 evento/s no tuvo rechazos: monitoreo con mediana de 6 ms, estado de los pasos 74 ms, estadísticas 51 ms (p95 0,9 s sin caché) e ingesta 4 ms. El servicio usó como máximo 137 MB.
