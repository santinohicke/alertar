# Conectividad del ESP32

La conectividad está en `AlertAR-2/src/conectividad.cpp`, `conectividad_config.h`, `registro.h` (cola en disco) y `protocolo.h` (formato del evento y del ACK). Es una capa agregada sobre la lógica local ([firmware.md](firmware.md)): si la red o el servidor fallan, el ESP32 sigue midiendo, decidiendo y mostrando el estado, y guarda los eventos para enviarlos después.

## Configuración

| Dónde | Qué | En Git |
|---|---|---|
| `include/conectividad_secrets.h` (copia de `conectividad_secrets.example.h`) | `ALERTAR_CONECTIVIDAD_HABILITADA`, URL de eventos, URL de reserva (lleva el `dispositivo_id`) y `ALERTAR_DEVICE_KEY` | No, está ignorado |
| `src/conectividad_config.h` | `DISPOSITIVO`, `PASO`, red Wi-Fi y tiempos | Sí |
| `src/certificado.h` | Raíz pública ISRG Root X2 de Let's Encrypt | Sí |

La clave de dispositivo es la del paso creado en el panel; nunca la clave administrativa. Si la clave está vacía, el ESP32 mide y guarda pero no envía. Para un paso nuevo hay que cambiar la clave, la URL de reserva, `DISPOSITIVO` y `PASO`, y volver a compilar.

## Recorrido de una medición

```text
loop() ──observar()──► cola RAM (64) ──tarea "registro"──► LittleFS /pendientes (128)
                                                                  │
                                       tarea "envio": Wi-Fi + NTP + TLS + HTTP POST
                                                                  │ ACK
                                                        LittleFS /enviados (últimos 16)
```

### 1. Cuándo se genera un evento

`conectividad::observar()` recibe el estado en cada ciclo y crea una muestra si:

- es la primera desde el encendido, o
- cambió el código, la validez de algún sensor o el estado del agua (confirmada o pendiente), o
- pasaron **15 s** desde la última muestra (muestra periódica).

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
- Hasta **128 pendientes**. Con la cola llena, el evento espera y se reintenta cada 1 s sin descartarlo; mientras tanto se descartan las muestras nuevas de la cola RAM. A una muestra cada 15 s, 128 eventos cubren unos 32 minutos sin conexión; los cambios de estado acortan ese margen.
- Los confirmados pasan a `/enviados`, donde se conservan los últimos 16.

### 4. Reloj

El ESP32 sincroniza la hora con `pool.ntp.org` y `time.nist.gov` y vuelve a hacerlo cada **5 minutos** (en Wokwi el reloj simulado se desvía). Sin hora válida no hace pedidos HTTP: los eventos esperan en la cola. Si la computadora que corre Wokwi se suspende, la cola se acumula y al volver se envía con atraso; el servidor los guarda con su hora de medición original y el panel los muestra como desactualizados.

### 5. Wi-Fi y TLS (tarea `envio`)

La tarea `envio` (núcleo 0, prioridad mínima, para no competir con la lógica) se conecta a `Wokwi-GUEST` y reintenta cada 15 s si se cae. La conexión HTTPS valida el certificado del servidor contra la raíz de `certificado.h`; **nunca** se desactiva esa validación. El handshake TLS tiene hasta 120 s (el simulador es lento para la criptografía) y cada pedido HTTP 5 s.

### 6. Reserva de secuencias

Antes del primer envío de cada encendido, el ESP32 llama a la URL de reserva con `{"instalacion_id": "…"}` y la clave del dispositivo. Acepta la respuesta solo si es 200 o 201, trae el mismo `instalacion_id` y un rango de 2^32. La base se guarda en RAM y se suma a la secuencia local de cada evento. Si la reserva falla, los eventos siguen en la cola.

### 7. Envío y confirmación

`POST` a la URL de eventos con `Content-Type: application/json` y `X-API-Key: <clave del dispositivo>`, de a un evento, empezando por la secuencia más baja. El evento se retira de `/pendientes` **solo** con un ACK válido: código 200 o 201 y cuerpo con `"guardado": true` y el mismo `evento_id`.

| Respuesta | Qué hace el ESP32 |
|---|---|
| 201 o 200 con ACK | Mueve el evento a `/enviados`; espera 1 s si quedan pendientes o 3 s si no |
| 200/201 sin ACK válido, otros códigos, error de red | Reintenta con espera creciente: 1, 2, 4, 8, 16 y 32 s |
| 429 o 503 | Espera lo que indique `Retry-After` (entre 5 y 60 s; 5 si no viene) o la espera creciente, lo que sea mayor |
| 400, 401, 403, 409, 413, 422 | Error permanente (contrato, clave o identidad): **bloquea** el envío y conserva el evento hasta corregir la configuración y escribir `/reintentar` en el monitor serie |

Con cola acumulada, cada ESP32 envía como máximo un evento por segundo. El servidor acepta 20 eventos/s entre todos los dispositivos (ver [api.md](api.md#límites-de-ritmo)).

## Comandos por el monitor serie

| Comando | Efecto |
|---|---|
| `/wifi off` / `/wifi on` | Simula un corte de red y lo restablece |
| `/reintentar` | Desbloquea el envío después de un error permanente |
| `/reiniciar` | Reinicia el ESP32 |

Cada 10 s el ESP32 imprime una línea JSON de diagnóstico con el estado de la conexión: Wi-Fi, bloqueo, pendientes, cola RAM, confirmados, descartados, último código HTTP, duración del envío y memoria libre. No se envía al servidor.

## Limitaciones conocidas

- Wokwi puede recrear la flash al iniciar una sesión nueva: se pierden los pendientes que no se hayan enviado, aunque la reserva evita reutilizar secuencias.
- La continuidad prolongada Wokwi → HTTPS → servidor y el comportamiento en hardware real no están validados formalmente. Ver [estado.md](estado.md).
