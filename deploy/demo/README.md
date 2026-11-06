# Herramientas de la demo

**Solo rama `demo`.** Scripts para preparar presentaciones; no usar contra un servicio real.

## Pasos de demo

En el servidor de la demo hay tres pasos con historial artificial, apagados (no envían), para que otros simulen sus dispositivos con las claves que muestra el panel:

| Paso | Línea | Dispositivo |
|---|---|---|
| Paso Floresta | Sarmiento | `esp32-02` / `tunel-02` |
| Paso Colegiales | Mitre | `esp32-03` / `tunel-03` |
| Paso Villa Soldati | Belgrano Sur | `esp32-04` / `tunel-04` |

Cada uno tiene 14 días de lecturas cada 15 s y en cada cambio de estado: más tránsito de día y en días hábiles, embotellamientos en hora pico, vehículos detenidos, tres tormentas que inundan Floresta y Villa Soldati (Colegiales solo llega a "verificando agua"), fallas de sensor, reinicios y cortes de conexión con envío atrasado. La instalación histórica ocupa las secuencias 0 a 2^32−1, así que la primera reserva de un firmware nuevo empieza después y no choca con el historial.

Para que alguien simule uno de esos pasos: copiar `AlertAR-2/include/conectividad_secrets.example.h` como `conectividad_secrets.h`, poner la clave que muestra el panel (pie de Monitoreo → Dispositivo), el `dispositivo_id` en la URL de reserva y `DISPOSITIVO`/`PASO` en `src/conectividad_config.h`, compilar y arrancar Wokwi.

## Scripts

- `generar_historial.py` reemplaza el historial de los pasos de `PASOS` (por nombre) por `HORAS` de datos artificiales con las reglas y textos del firmware. No crea pasos ni cambia claves. Hacer un respaldo de la base antes de ejecutarlo.
- `carga.py` simula 20 paneles abiertos y 10 ESP32 vaciando su cola durante 60 s contra la API local, e informa tiempos y códigos de respuesta. Los envíos van con cuerpo vacío: pasan autenticación y límites, y la API los rechaza con 400 sin guardar nada.

Ambos se ejecutan en el servidor con el entorno privado cargado (`set -a; . ~/.config/alertar/alertar.env; set +a`) y el Python del servicio.

## Volver al proyecto real

Desplegar `main` y vaciar las claves guardadas para la demo con `UPDATE tuneles SET clave_demo = NULL`. Si los pasos de demo ya no hacen falta, borrarlos desde el panel.
