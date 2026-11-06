# Conectividad del ESP32

La conectividad está en `AlertAR-2/src/conectividad.cpp`, `conectividad_config.h`, `registro.h` (cola en disco) y `protocolo.h` (formato del evento y del ACK). Es una capa agregada sobre la lógica local ([firmware.md](firmware.md)): si la red o el servidor fallan, el ESP32 sigue midiendo, decidiendo y mostrando el estado, y guarda los eventos para enviarlos después.

## Configuración

| Dónde | Qué | En Git |
|---|---|---|
| `include/conectividad_secrets.h` (copia de `conectividad_secrets.example.h`) | `ALERTAR_CONECTIVIDAD_HABILITADA`, URL de eventos, URL de reserva (lleva el `dispositivo_id`) y `ALERTAR_DEVICE_KEY` | No, está ignorado |
| `src/conectividad_config.h` | `DISPOSITIVO`, `PASO`, red Wi-Fi y tiempos. `ALERTAR_MUESTRA_MS` fija el intervalo de las muestras periódicas: 15 s en `main`, 5 s en `demo` | Sí |
| `src/certificado.h` | Raíces públicas Root YE e ISRG Root X2 de Let's Encrypt | Sí |

La clave de dispositivo es la del paso creado en el panel; nunca la clave administrativa. Si la clave está vacía, el ESP32 mide y guarda pero no envía. Para un paso nuevo hay que cambiar la clave, la URL de reserva, `DISPOSITIVO` y `PASO`, y volver a compilar.

## Recorrido de una medición

```text
loop() ──observar()──► cola RAM (64) ──tarea "registro"──► LittleFS /pendientes (128)
                                                                  │
                                       tarea "envio": Wi-Fi + NTP + TLS + POST por lotes
                                                                  │ ACK
                                                        LittleFS /enviados (últimos 16)
```

### 1. Cuándo se genera un evento

`conectividad::observar()` recibe el estado en cada ciclo y crea una muestra si:

- es la primera desde el encendido, o
- cambió el código, la validez de algún sensor o el estado del agua (confirmada o pendiente), o
- pasaron **15 s** desde la última muestra (muestra periódica; `ALERTAR_MUESTRA_MS`, 5 s en la rama `demo`).

Con el reloj sincronizado el intervalo se mide en hora real, aunque Wokwi simule más lento que el tiempo real. Sin hora, o si el reloj saltó hacia atrás, se mide con `millis()`.

La muestra toma en ese momento la hora (`time()`), el `uptime_ms`, el código, el diagnóstico, las alturas y el agua. Si la cola en RAM (64 lugares) está llena, la muestra nueva se descarta y se cuenta en `descartados`.

### 2. Identidad del evento

| Campo | Origen |
|---|---|
| `instalacion` | 32 hexadecimales aleatorios generados la primera vez y guardados en la memoria no volátil (NVS). Identifica la flash. No viaja como campo propio: forma parte del `evento_id` y se usa para la reserva |
| `arranque_id` | 32 hexadecimales aleatorios nuevos en cada encendido |
| secuencia local | Contador guardado en NVS por bloques de 1024: el límite del bloque se guarda antes de usarlo, así un reinicio salta los números no usados pero nunca repite uno |
| `evento_id` | `<dispositivo>-<instalacion>-<secuencia local>` |
| `secuencia` enviada | Base reservada en el servidor + secuencia local |
| `medido_en` | Hora UTC en formato `AAAA-MM-DDTHH:MM:SSZ`, o `null` si el reloj todavía no se sincronizó |

### 3. Cola en disco (tarea `registro`)

La tarea `registro` (núcleo 0, prioridad 1) toma las muestras de la cola RAM, las convierte en JSON y las guarda en LittleFS:

- Cada evento es un archivo `/pendientes/<secuencia de 20 dígitos>.log`. Se escribe primero en un temporal, se vuelve a leer para compararlo y recién entonces se renombra: un corte de energía no deja un archivo a medias.
- Hasta **128 pendientes**. Con la cola llena, el evento espera y se reintenta cada 1 s sin descartarlo; mientras tanto se descartan las muestras nuevas de la cola RAM. A una muestra cada 15 s, 128 eventos cubren unos 32 minutos sin conexión (unos 10 minutos a 5 s); los cambios de estado acortan ese margen.
- Los confirmados pasan a `/enviados`, donde se conservan los últimos 16.

### 4. Reloj

El ESP32 sincroniza la hora con `pool.ntp.org` y `time.nist.gov` y vuelve a hacerlo cada **5 minutos**. Cada vez que se conecta el Wi-Fi sin tener hora, la vuelve a pedir en el momento. Sin hora válida no hace pedidos HTTP: los eventos esperan en la cola, y esa espera no cuenta como fallo (no activa la espera creciente). Si la computadora que corre Wokwi se suspende, la cola se acumula y al volver se envía con atraso; el servidor los guarda con su hora de medición original y el panel los muestra como desactualizados.

Además, cada respuesta `201` del servidor trae `recibido_en`. Si el reloj del ESP32 se aleja más de 0,3 s de esa hora (corregida por la mitad de la duración del pedido, solo en pedidos de menos de 3 s), se ajusta a la del servidor. Así el reloj no se atrasa entre sincronizaciones NTP aunque Wokwi simule más lento que el tiempo real.

### 5. Wi-Fi y TLS (tarea `envio`)

La tarea `envio` (núcleo 0, prioridad 1; la lógica corre en el núcleo 1) se conecta a `Wokwi-GUEST` y reintenta cada 15 s si se cae. La conexión HTTPS valida el certificado del servidor contra las raíces de `certificado.h` (Root YE, la raíz de la cadena actual de Let's Encrypt, e ISRG Root X2); **nunca** se desactiva esa validación. No se fijan certificados intermedios porque rotan.

El handshake TLS tiene hasta 120 s (el simulador es lento para la criptografía) y cada pedido HTTP 15 s. El watchdog de tareas está en 180 s, por encima del handshake más largo: reinicia la placa si el núcleo 0 se cuelga.

La conexión se mantiene abierta entre pedidos. Solo se cierra ante un error de red: si el servidor respondió, aunque sea con un 429 o un 500, se sigue usando la misma.

### 6. Reserva de secuencias

Antes del primer envío de cada encendido, el ESP32 llama a la URL de reserva con `{"instalacion_id": "…"}` y la clave del dispositivo. Acepta la respuesta solo si es 200 o 201, trae el mismo `instalacion_id` y un rango de 2^32. La base se guarda en RAM y se suma a la secuencia local de cada evento. Si la reserva falla, los eventos siguen en la cola.

### 7. Envío y confirmación

Cada pedido lleva hasta **9 eventos** a `<URL de eventos>/lote` (`POST /api/eventos/lote`, ver [api.md](api.md#lotes)) con `Content-Type: application/json` y `X-API-Key: <clave del dispositivo>`. El primero es el **más nuevo**, así el panel muestra el estado actual con el primer pedido; los demás son los más viejos, en orden, para ir completando el historial. Con un solo pendiente se usa `POST /api/eventos`.

Un evento se retira de `/pendientes` **solo** con su ACK: código 200 o 201 y, para ese evento, `"guardado": true` y el mismo `evento_id`. Si el servidor no tiene la ruta de lotes (401, 404 o 405 en esa ruta), el ESP32 sigue de a uno por `/api/eventos`, siempre el más nuevo primero.

| Respuesta | Qué hace el ESP32 |
|---|---|
| 201 o 200 con ACK de todos | Mueve los eventos a `/enviados` y espera 1 s antes del siguiente pedido |
| 200/201 sin ACK válido, otros códigos, error de red | Reintenta con espera creciente: 1, 2, 4, 8, 16 y 32 s |
| 429 o 503 | Espera lo que indique `Retry-After` (entre 5 y 60 s; 5 si no viene) o la espera creciente, lo que sea mayor |
| 400, 401, 403, 409, 413, 422 (del pedido o de un evento del lote) | Error permanente (contrato, clave o identidad): confirma los eventos que sí se guardaron, **bloquea** el envío y conserva el resto hasta corregir la configuración y escribir `/reintentar` en el monitor serie |

Cada ESP32 hace como máximo un pedido por segundo; con cola acumulada eso son hasta 9 eventos por segundo. El servidor acepta 20 pedidos/s entre todos los dispositivos (ver [api.md](api.md#límites-de-ritmo)); un lote cuenta como un pedido.

## Comandos por el monitor serie

| Comando | Efecto |
|---|---|
| `/wifi off` / `/wifi on` | Simula un corte de red y lo restablece |
| `/reintentar` | Desbloquea el envío después de un error permanente |
| `/reiniciar` | Reinicia el ESP32 |

Cada 10 s el ESP32 imprime una línea JSON de diagnóstico con el estado de la conexión: Wi-Fi, reloj, bloqueo, pendientes, cola RAM, confirmados, descartados, último código HTTP, duración del envío, `primer_ack_ms` (cuándo se confirmó el primer evento), `lote_max`, `ajustes_reloj` y `desfase_reloj_ms`, pila libre de cada tarea (`pila_envio`, `pila_registro`) y memoria libre. No se envía al servidor.

## Limitaciones conocidas

- Wokwi puede recrear la flash al iniciar una sesión nueva: se pierden los pendientes que no se hayan enviado, aunque la reserva evita reutilizar secuencias.
- Wokwi simula más lento que el tiempo real. El intervalo de las muestras y la hora de medición se corrigen (ver arriba), pero el `uptime_ms` es tiempo simulado.
- La partición LittleFS es de 384 KB. Un ESP32 grabado con una tabla de particiones distinta debe borrarse por completo antes de grabar este firmware; si no, LittleFS no monta y no se envía nada.
- El comportamiento en hardware real no está validado. Ver [estado.md](estado.md).
