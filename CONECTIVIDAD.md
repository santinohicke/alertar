# Conectividad del ESP32

El firmware activo está en `AlertAR-2/`. La decisión de riesgo, los LEDs y la LCD funcionan localmente. La red agrega envío de eventos a la [API pública de AlertAR](https://raspi.tail5a3b96.ts.net/), protegida con una clave exclusiva de dispositivo.

## Configuración

`AlertAR-2/include/conectividad_secrets.example.h` contiene las dos rutas HTTPS públicas y una clave vacía. Se copia como `conectividad_secrets.h`, se coloca allí la clave de **dispositivo** y se habilita la conexión. Ese archivo local, la clave administrativa, los binarios y los registros de diagnóstico no se suben a GitHub. Sin clave, el firmware sigue midiendo y guardando, pero no envía eventos.

El cliente verifica el certificado con la raíz pública de `certificado.h`; no usa TLS inseguro. Espera a tener reloj NTP antes de conectar y solicita resincronización cada cinco minutos para limitar la deriva del reloj simulado en Wokwi. La fecha de medición y la fecha de recepción se mantienen separadas.

## Cola y reintentos

- Muestra periódica cada 15 segundos y eventos al cambiar de estado.
- Hasta 64 muestras en RAM, 128 eventos pendientes en LittleFS y 16 confirmados retenidos. Las 128 muestras periódicas equivalen aproximadamente a 32 minutos sin conexión; los cambios de estado reducen ese margen.
- Cada evento conserva `evento_id`, `instalacion_id` y secuencia entre reintentos. Una instalación nueva de flash solicita otro rango de secuencias a la API.
- La cola retira un evento únicamente tras un ACK válido. Los reintentos respetan `Retry-After` en 429/503; 401/403 conservan el evento y requieren corregir la configuración.
- El código actual separa envíos por 1 segundo mientras hay pendientes y por 3 segundos cuando se vacía la cola. La estabilidad de ese ritmo con Wokwi y Funnel aún requiere una prueba prolongada.

LittleFS evita perder pendientes durante un reinicio de la misma instalación de flash. Wokwi puede recrear la flash al iniciar una sesión nueva; en ese caso la API evita reutilizar secuencias, pero no puede recuperar archivos que el simulador haya descartado.

## Estado de validación

Se observaron entregas Wokwi → HTTPS → Raspberry Pi con ACK y recuperación parcial de la cola. Después aparecieron demoras y errores de conexión; por eso no se declara estable la comunicación continua. Los ajustes posteriores de recuperación y sincronización de reloj están en el código, pero su resultado prolongado no está validado. También se observó un reinicio de Wokwi con aviso de watchdog; la validación en hardware real sigue pendiente.

La API y el panel publicados están descritos en [PANEL_RASPBERRY.md](PANEL_RASPBERRY.md). El contrato de eventos está en [backend/README.md](backend/README.md).
