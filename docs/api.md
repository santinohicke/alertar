# API REST y almacenamiento

La API está en `backend/app.py` (contrato, ingesta, estado e historial) y `backend/panel.py` (panel, autenticación, límites, gestión de pasos, estadísticas y exportación). Usa Flask y SQLite, sin otras dependencias. Las reglas de acceso de cada ruta están en [seguridad.md](seguridad.md).

## Rutas

| Método | Ruta | Quién | Uso |
|---|---|---|---|
| `GET` | `/health` | Cualquiera | Comprueba que el servicio y la base respondan |
| `POST` | `/api/eventos` | Clave del dispositivo o administrativa | Recibir un evento |
| `POST` | `/api/dispositivos/{dispositivo_id}/reserva` | Clave del dispositivo o administrativa | Reservar un rango de secuencias para una instalación de firmware |
| `GET` | `/api/pasos/{paso_id}/estado` | Panel o administrativa | Último estado conocido y su vigencia |
| `GET` | `/api/pasos/{paso_id}/historial` | Panel o administrativa | Eventos paginados (`limite` 1–200, `offset`) |
| `GET` | `/api/pasos/{paso_id}/estadisticas` | Panel o administrativa | Resumen de un rango (`rango=1h|6h|24h|7d|all`) |
| `GET` | `/api/pasos/{paso_id}/exportar` | Panel o administrativa | Archivo CSV o JSON (`formato`, `desde`, `hasta`) |
| `GET` | `/api/panel/{paso_id}` | Panel o administrativa | Estado y últimos 20 eventos para Monitoreo |
| `GET` | `/api/tuneles` | Panel o administrativa | Pasos con último código y última recepción |
| `POST` | `/api/tuneles` | Panel (con CSRF) o administrativa | Crear un paso y su clave |
| `PATCH` | `/api/tuneles/{paso_id}` | Panel (con CSRF) o administrativa | Editar nombre, ubicación y coordenadas |
| `POST` | `/api/tuneles/{paso_id}/clave` | Panel (con CSRF) o administrativa | Reemplazar la clave del dispositivo |
| `DELETE` | `/api/tuneles/{paso_id}` | Panel (con CSRF) o administrativa | Borrar el paso, su clave, sus eventos y sus reservas |
| `GET` `POST` | `/login`, `POST /salir` | Navegador | Iniciar y cerrar la sesión del panel |

"Panel" significa una sesión iniciada con la contraseña del panel. "Administrativa" es la clave `ALERTAR_API_KEY` en el encabezado `X-API-Key`.

## Contrato del evento (v1)

Cada `POST /api/eventos` lleva un único objeto JSON de hasta 16 KiB con exactamente estos campos (un campo de más o de menos se rechaza):

| Campo | Regla | Para qué sirve |
|---|---|---|
| `version` | Entero `1` | Versión del contrato |
| `evento_id` | 1–80 caracteres `A-Z a-z 0-9 _ -` | Identidad del evento; un reintento usa la misma |
| `dispositivo_id`, `paso_id` | Igual que arriba; deben estar registrados juntos en `tuneles` | Qué ESP32 y qué paso |
| `arranque_id` | Igual que arriba | Identifica cada encendido del ESP32 |
| `secuencia` | Entero 0 a 2^63−1, creciente por dispositivo y persistente entre reinicios | Orden real de las mediciones |
| `uptime_ms` | Entero 0 a 2^63−1 | Tiempo desde el encendido; informativo |
| `medido_en` | ISO 8601 con zona horaria o `null`; hasta 60 s en el futuro | Hora de la medición según el reloj del ESP32 (se guarda en UTC) |
| `codigo` | Uno de `OK-001`, `INF-001`, `ERR-001` a `ERR-007` | Estado calculado por el ESP32 ([tabla_logica.md](tabla_logica.md)) |
| `diagnostico` | Texto de 1 a 200 caracteres | Descripción del estado |
| `sensor1_valido`, `sensor2_valido` | Booleano | Si la lectura ultrasónica de cada carril es válida |
| `obstruccion_carril1_cm`, `obstruccion_carril2_cm` | Número finito de 0 a 398 si el sensor es válido; `null` si no | Altura de la obstrucción |
| `agua_activa`, `agua_pendiente` | Booleanos; no pueden ser ambos `true` | Agua confirmada o en confirmación |

El servidor agrega `recibido_en` (hora UTC del servidor al guardar). La hora de medición y la de recepción se guardan por separado: un lote atrasado conserva la hora en que se midió.

## Qué pasa al recibir un evento

1. **Tamaño y formato:** más de 16 KiB → 413; contenido que no es JSON → 415.
2. **Autenticación y límite de ritmo:** antes de llegar a la ruta (ver [seguridad.md](seguridad.md)). Sin clave válida → 401; sin fichas de ingesta → 429.
3. **Validación del contrato:** cualquier regla de la tabla anterior que no se cumpla → 400 `evento_invalido` con el detalle.
4. **Pertenencia:** el par `paso_id`/`dispositivo_id` debe existir en `tuneles` (si no → 400) y la clave usada debe ser la de ese paso (si no → 403).
5. **Guardado:** se inserta en `eventos` dentro de una transacción. La respuesta `201 {"guardado": true}` se envía después del commit; es la confirmación (ACK) que el ESP32 espera para retirar el evento de su cola.
6. **Duplicados:** si el mismo `evento_id` ya existe con exactamente el mismo contenido, responde `200` con `duplicado: true` y la fecha de recepción original. No se inserta de nuevo.
7. **Conflictos:** si el `evento_id` o la `secuencia` ya existen con otro contenido → 409. El ESP32 no debe descartarlo: indica un error del emisor.
8. **Fallo de almacenamiento** → 503 sin ACK; el ESP32 reintenta.

## Reserva de secuencias

Cada instalación del firmware (cada flash) tiene un `instalacion_id` de 32 caracteres hexadecimales. Antes de su primer envío, el ESP32 llama a `POST /api/dispositivos/{dispositivo_id}/reserva` con `{"instalacion_id": "…"}`. La API le asigna en una transacción un rango de 2^32 secuencias que empieza después de la mayor secuencia ya usada por ese dispositivo y del último rango reservado. Repetir el pedido devuelve el mismo rango (200); uno nuevo responde 201. El ESP32 suma esa base a su contador local, así una flash nueva nunca reutiliza secuencias anteriores.

## Estado y vigencia

`GET /api/pasos/{paso_id}/estado` toma el evento de mayor secuencia (no el último recibido) y agrega:

- `comunicacion`: `recepcion_reciente` si se recibió un evento nuevo en los últimos 60 s, si no `sin_comunicacion`. Un duplicado no renueva esta señal.
- `actualidad_medicion`: `reciente` si la medición tiene menos de 60 s, `desactualizada` si es más vieja, `desconocida` si no tiene hora.
- `antiguedad_recepcion_s` y `antiguedad_medicion_s`.

El umbral de 60 s es `STALE_SECONDS`. Un `OK-001` solo debe leerse como paso habilitado si ambas señales son recientes; el panel aplica esa regla ([panel.md](panel.md)).

## Estadísticas

`GET /api/pasos/{paso_id}/estadisticas?rango=…` (`backend/estadisticas.py`) lee del rango solo los campos necesarios del JSON guardado y calcula:

- **Tiempo por estado:** los eventos se ordenan por hora de medición; cada uno cuenta hasta 15 s o hasta el siguiente, lo que sea menor. Con eso se obtienen el tiempo por código, el tiempo en `OK-001`, con agua activa, con cada sensor válido y el tiempo monitoreado total.
- **Conteos:** eventos en el rango y en la base, arranques distintos, eventos sin hora, última recepción, saltos de secuencia dentro de cada arranque, demora promedio y máxima entre medición y recepción, promedio y máximo de obstrucción por carril.
- **Actividad:** eventos por bloque de tiempo (5 min, 30 min, 1 h o 6 h según el rango; en `all` según el período) y cuánto tiempo hubo de cada severidad en cada bloque.
- **Franja de estado:** el período dividido en 720 tramos; cada uno toma la severidad más grave que ocupe al menos el 10 % de su tiempo cubierto.
- **Obstrucción:** como máximo 600 puntos, cada uno con el máximo de su bloque.

El resultado se guarda 10 s en memoria por paso y rango. Con 84.000 eventos, `24h` tarda unos 70 ms y `all` menos de 1 s.

## Exportación

`GET /api/pasos/{paso_id}/exportar?formato=csv|json&desde=…&hasta=…` genera el archivo en el servidor y lo envía por partes con su propia conexión a SQLite, sin cargarlo entero en memoria. `desde` y `hasta` son opcionales y deben ser ISO 8601 con zona horaria; se comparan con la hora de medición (o la de recepción si falta). El orden es de la secuencia más alta a la más baja. El CSV empieza con BOM para Excel y usa `true`/`false` en los booleanos. Fechas inválidas o `desde` posterior a `hasta` → 400.

## Gestión de pasos

- **Crear:** nombre de 1 a 60 caracteres; `paso_id` y `dispositivo_id` opcionales (si faltan, `tunel-NN` y `esp32-NN`), con 1–80 caracteres `a-z 0-9 _ -` y sin repetirse; ubicación de hasta 120 caracteres y coordenadas opcionales (latitud −90 a 90, longitud −180 a 180, las dos o ninguna). Genera una clave aleatoria de 32 caracteres, guarda su hash y la devuelve una sola vez.
- **Editar:** nombre, ubicación y coordenadas con las mismas reglas.
- **Regenerar clave:** la anterior deja de funcionar de inmediato.
- **Borrar:** elimina el paso, sus eventos y sus reservas en una transacción. `tunel-01` no se borra porque la API lo vuelve a crear al iniciar.

## Almacenamiento

SQLite, archivo indicado por `ALERTAR_DATABASE`. Las tablas se crean y actualizan al iniciar, sin borrar datos.

| Tabla | Columnas | Restricciones |
|---|---|---|
| `eventos` | `id`, `evento_id`, `dispositivo_id`, `paso_id`, `secuencia`, `recibido_en`, `payload` (el JSON validado) | Únicos `(dispositivo_id, evento_id)` y `(dispositivo_id, secuencia)`; índices por `(paso_id, secuencia)` y `(paso_id, recibido_en)` |
| `instalaciones` | `dispositivo_id`, `instalacion_id`, `base`, `tamano` | Clave `(dispositivo_id, instalacion_id)` |
| `tuneles` | `paso_id`, `nombre`, `dispositivo_id`, `api_key` (hash `sha256:`), `creado_en`, `ubicacion`, `latitud`, `longitud` | `paso_id` clave; `dispositivo_id` y `api_key` únicos |

## Límites de ritmo

Cada pedido a `/api/*` consume una ficha de una cubeta global del proceso según su tipo: **ingesta** (envíos y reservas), **lectura** (consultas), **admin** (gestión de pasos) y **login**. Cada cubeta se recarga a `ritmo` fichas por segundo hasta un máximo de `ráfaga`. Sin fichas, la API responde 429 con `Retry-After: 5`; el firmware y el panel esperan y reintentan sin perder datos. Además, como máximo `ALERTAR_CONCURRENCIA` pedidos se atienden a la vez; el resto recibe 429 en lugar de acumularse.

| Tipo | Por defecto (servidor) | Raspberry Pi | Variable |
|---|---|---|---|
| Ingesta | 20/s, ráfaga 60 | 2/s, ráfaga 4 | `ALERTAR_LIMITE_INGESTA` |
| Lectura | 30/s, ráfaga 90 | 4/s, ráfaga 8 | `ALERTAR_LIMITE_LECTURA` |
| Admin | 2/s, ráfaga 10 | 0,5/s, ráfaga 6 | `ALERTAR_LIMITE_ADMIN` |
| Login | 0,1/s, ráfaga 5 | igual | `ALERTAR_LIMITE_LOGIN` |
| Simultáneos | 16 | 4 | `ALERTAR_CONCURRENCIA` |

Las variables usan el formato `ritmo,ráfaga`. Como los límites y la caché de estadísticas viven en memoria del proceso, gunicorn debe correr con un solo proceso y varios hilos.
