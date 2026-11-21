# Arquitectura y recorrido de los datos

AlertAR tiene tres partes que se comunican en un solo sentido: el **ESP32** de cada paso mide y decide, la **API** guarda y resume, y el **panel** muestra. La seguridad del paso no depende de las dos últimas: el semáforo y la pantalla del ESP32 funcionan aunque no haya Internet.

```text
┌──────────────── ESP32 (uno por paso) ────────────────┐
│ ultrasónicos + agua → lógica local → LEDs y LCD      │
│                     → evento JSON → cola en LittleFS │
└──────────────────────────┬───────────────────────────┘
                           │ HTTPS · X-API-Key (clave del dispositivo)
                           ▼
┌──────────────── Servidor ────────────────────────────┐
│ Tailscale Funnel :8443 → gunicorn → Flask            │
│ autenticación → límite de ritmo → validación         │
│ → SQLite (eventos, pasos, reservas)                  │
│ → estado, historial, estadísticas, exportación       │
└──────────────────────────┬───────────────────────────┘
                           │ HTTPS · sesión del panel
                           ▼
┌──────────────── Navegador ───────────────────────────┐
│ Monitoreo (5 s) · Historial · Estadísticas · Mapa    │
└──────────────────────────────────────────────────────┘
```

## Recorrido paso a paso

| # | Etapa | Qué pasa | Dónde se detalla |
|---|---|---|---|
| 1 | Medición | Cada 260–320 ms el ESP32 mide los dos carriles (pulso ultrasónico, eco por interrupción) y el sensor de agua | [firmware.md](firmware.md#medición-de-cada-carril) |
| 2 | Interpretación | La distancia se convierte en altura de obstrucción; el agua pasa por histéresis y 20 s de confirmación; la ocupación necesita 60 s para ser persistente | [firmware.md](firmware.md#ocupación-y-persistencia) |
| 3 | Decisión local | `decidir()` elige uno de nueve códigos por prioridad y enciende el LED y la LCD | [firmware.md](firmware.md#decisión-del-estado), [tabla_logica.md](tabla_logica.md) |
| 4 | Evento | Si cambió el estado o pasaron 15 s, se crea un evento con identidad (`evento_id`, `arranque_id`, secuencia) y hora de medición | [conectividad.md](conectividad.md#1-cuándo-se-genera-un-evento) |
| 5 | Cola | El evento se guarda como archivo en LittleFS antes de intentar enviarlo; sobrevive a reinicios y cortes | [conectividad.md](conectividad.md#3-cola-en-disco-tarea-registro) |
| 6 | Transporte | Con Wi-Fi y hora sincronizada, se envía por HTTPS validando el certificado; la primera vez se reserva un rango de secuencias | [conectividad.md](conectividad.md#5-wi-fi-y-tls-tarea-envio) |
| 7 | Ingreso | El servidor comprueba tamaño, clave del dispositivo, ritmo y contrato del JSON | [seguridad.md](seguridad.md#orden-de-los-controles-en-cada-pedido), [api.md](api.md#qué-pasa-al-recibir-un-evento) |
| 8 | Guardado | SQLite guarda el evento con su hora de recepción; los duplicados no se reinsertan; al terminar responde el ACK | [api.md](api.md#almacenamiento) |
| 9 | Confirmación | Con el ACK, el ESP32 retira el evento de la cola; sin ACK, lo reintenta con esperas crecientes | [conectividad.md](conectividad.md#7-envío-y-confirmación) |
| 10 | Consulta | El panel pide el estado del paso cada 5 s y el de todos los pasos cada 10 s; la API calcula la vigencia (60 s) | [api.md](api.md#estado-y-vigencia), [panel.md](panel.md#estado-y-vigencia) |
| 11 | Análisis | Estadísticas y exportación se calculan en el servidor sobre la base completa | [api.md](api.md#estadísticas), [panel.md](panel.md#estadísticas) |

Con conexión, un cambio de estado llega al panel en unos 2 a 7 segundos: el envío del ESP32 (menos de 1 s con la conexión abierta, más hasta 1 s de pausa entre pedidos) más el intervalo de consulta del panel (hasta 5 s).

## Identidades y horas

| Dato | Lo crea | Para qué |
|---|---|---|
| `paso_id`, `dispositivo_id` | El panel al crear el paso | Qué paso y qué ESP32; viajan en cada evento |
| `instalacion` | El ESP32 la primera vez (NVS) | Pedir un rango de secuencias propio de esa flash |
| `arranque_id` | El ESP32 en cada encendido | Contar reinicios y detectar saltos de secuencia dentro de un encendido |
| `evento_id` | El ESP32 | Reintentar el mismo evento sin duplicarlo |
| `secuencia` | El ESP32 (base reservada + contador local) | Orden real; el estado actual es el de mayor secuencia |
| `medido_en` | Reloj del ESP32 (NTP) | Cuándo ocurrió; define la vigencia y las estadísticas |
| `recibido_en` | Reloj del servidor | Cuándo llegó; define si hay comunicación |

Separar las dos horas evita un error clásico: un lote de eventos viejos que llega tarde no hace parecer actual un estado antiguo.

## Dónde vive cada dato

| Dato | Lugar | Duración |
|---|---|---|
| Estado actual, contadores de persistencia | RAM del ESP32 | Hasta el próximo reinicio |
| Eventos sin confirmar | LittleFS del ESP32 (`/pendientes`, hasta 128) | Hasta recibir el ACK |
| Contador de secuencia e `instalacion` | NVS del ESP32 | Permanente en esa flash |
| Eventos, pasos, reservas | SQLite del servidor | Permanente; se respalda antes de cada despliegue |
| Claves de dispositivo | SQLite, solo como hash | Hasta regenerar o borrar el paso |
| Clave administrativa | Entorno privado del servidor | Hasta cambiarla |
| Sesión del panel | Cookie firmada del navegador | 8 horas |
| Resúmenes de estadísticas | Memoria del servidor (10 s) y del navegador (60 s) | Temporales |

## Qué pasa si algo falla

| Falla | Efecto | Recuperación |
|---|---|---|
| Sin Internet o servidor caído | El ESP32 sigue mostrando el estado local; los eventos se acumulan en LittleFS | Al volver se envía primero el más nuevo y el resto en lotes de hasta 9 por segundo |
| Sin hora (NTP) | No se envía; los eventos esperan | Al sincronizar se envían con su hora |
| Cola llena (128) | Se descartan muestras nuevas hasta liberar lugar | Al enviar se vacía |
| Clave inválida o paso equivocado | El envío se bloquea y conserva los eventos | Corregir la configuración y `/reintentar` |
| Servidor saturado | 429 con `Retry-After`; nadie pierde datos | El ESP32 y el panel esperan y reintentan |
| Panel sin datos recientes | El paso se muestra gris, *Sin confirmar*, nunca verde | Al llegar un dato nuevo vuelve el color |
