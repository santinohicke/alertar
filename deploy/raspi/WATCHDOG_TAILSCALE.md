# Watchdog de Tailscale para AlertAR

Instalado en la Raspberry Pi el 19/09/2026 para recuperar el caso en que `tailscaled` permanece ejecutándose pero deja de recibir el mapa de red del servidor de coordinación.

## Política

- Ejecución cada 60 segundos mediante `alertar-tailscale-watchdog.timer`.
- La API local debe responder correctamente; una falla propia de AlertAR no provoca un reinicio de Tailscale.
- Solo cuentan como falla los estados distintos de `Running`, los errores al consultar `tailscale status --json` y los avisos que contienen `network map` o `coordination server`.
- Se requieren tres fallas consecutivas antes de actuar.
- Como máximo se intenta un reinicio cada 15 minutos.
- Antes de reiniciar se persiste el cooldown para impedir bucles incluso si `systemctl` falla.
- Después del reinicio se comprueban nuevamente la salud de Tailscale y la configuración de Funnel.
- Otros avisos de Tailscale, por ejemplo una versión nueva disponible, no producen reinicios.

## Archivos instalados

```text
/usr/local/libexec/alertar-tailscale-watchdog.py
/etc/systemd/system/alertar-tailscale-watchdog.service
/etc/systemd/system/alertar-tailscale-watchdog.timer
/var/lib/alertar-tailscale-watchdog/state.json
```

El estado y los scripts son propiedad de `root`. El servicio se ejecuta como `root` porque únicamente esa identidad puede reiniciar `tailscaled`. La unidad restringe escritura al directorio de estado y aplica protecciones de systemd.

## Operación

Consultar el timer:

```bash
systemctl list-timers alertar-tailscale-watchdog.timer
```

Consultar las decisiones del watchdog:

```bash
sudo journalctl -u alertar-tailscale-watchdog.service --since "1 hour ago" --no-pager
```

Deshabilitarlo sin borrar archivos:

```bash
sudo systemctl disable --now alertar-tailscale-watchdog.timer
```

Volver a habilitarlo:

```bash
sudo systemctl enable --now alertar-tailscale-watchdog.timer
```

## Instalación reproducible

Los archivos fuente y las seis pruebas están en `deploy/raspi/`. El instalador está adaptado a la Pi existente: crea un respaldo local en su directorio de proyecto, valida las unidades con `systemd-analyze`, habilita el timer y ejecuta una primera comprobación sin forzar fallas. No es un instalador genérico para cualquier Pi.

```bash
sudo python3 deploy/raspi/instalar_watchdog_tailscale.py
```

No se modifican credenciales, la configuración de Funnel, la API ni la base de datos.
