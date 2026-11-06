# Backend y panel de AlertAR

`app.py` implementa la API Flask y SQLite; `panel.py`, `templates/` y `static/` agregan el panel. En la Raspberry Pi, `../deploy/raspi/gateway.py` monta Flask junto a una API FastAPI anterior en un único proceso Uvicorn. Esa API anterior no está incluida en este repositorio.

El modo publicado usa `ALERTAR_REQUIRE_AUTH=1`, una clave administrativa y otra clave exclusiva de dispositivo para ingesta y reserva. Las claves se cargan desde el entorno privado del servidor; no están en el código ni en la plantilla del firmware. Ver [PANEL_RASPBERRY.md](../PANEL_RASPBERRY.md) y [CONECTIVIDAD.md](../CONECTIVIDAD.md) para arquitectura y límites conocidos.

## Iniciar

Desde la raíz del repositorio:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
cd backend
.venv/bin/flask --app app run --host=127.0.0.1 --port=5001
```

La aplicación crea las tablas si no existen, sin borrar datos. SQLite se guarda en `backend/instance/alertar.sqlite3`, ignorada por Git.

Este modo de desarrollo no exige autenticación y solo escucha en `127.0.0.1`. Wokwi puede acceder por `http://host.wokwi.internal:5001` con una configuración local adecuada. **No publicar este modo en Internet.** En la Pi se requiere `ALERTAR_REQUIRE_AUTH=1`, clave administrativa de al menos 24 caracteres y clave de dispositivo distinta. El panel usa sesión de lectura de ocho horas, cookie `Secure`/`HttpOnly`/`SameSite=Strict` y protección CSRF.

## Variables de entorno

| Variable | Uso |
| --- | --- |
| `ALERTAR_REQUIRE_AUTH` | `1` exige autenticación (obligatorio al publicar). |
| `ALERTAR_API_KEY` | Clave administrativa y contraseña del panel, mínimo 24 caracteres. |
| `ALERTAR_DEVICE_KEY` | Clave inicial de `tunel-01`. Si falta, se genera una aleatoria; las demás claves se crean desde el panel. |
| `ALERTAR_DATABASE` | Ruta de la base SQLite. |
| `ALERTAR_LIMITE_INGESTA`, `ALERTAR_LIMITE_LECTURA`, `ALERTAR_LIMITE_ADMIN`, `ALERTAR_LIMITE_LOGIN` | Límites globales del proceso como `ritmo,ráfaga` (pedidos por segundo). Por defecto `20,60`, `30,90`, `2,10` y `0.1,5`, pensados para un servidor con decenas de ESP32 y paneles abiertos. La Raspberry Pi usa `2,4`, `4,8`, `0.5,6` desde `deploy/raspi/limites.conf`. |
| `ALERTAR_CONCURRENCIA` | Pedidos atendidos a la vez (por defecto 16; la Pi usa 4). Conviene igualarlo a los hilos de gunicorn. |
| `ALERTAR_ENABLE_SIMULATOR` | `1` habilita `/api/simulador/*` (solo para desarrollo; inserta eventos falsos). |

Las claves de dispositivo se guardan como hash; la clave en claro solo se muestra al crearla o reemplazarla. Las escrituras de administración desde el panel exigen el encabezado `X-CSRF-Token`.

## Probar manualmente

En otra terminal, desde la carpeta backend:

```bash
curl http://127.0.0.1:5001/health
curl -i -H 'Content-Type: application/json' --data-binary @examples/evento.json http://127.0.0.1:5001/api/eventos
curl http://127.0.0.1:5001/api/pasos/tunel-01/estado
curl 'http://127.0.0.1:5001/api/pasos/tunel-01/historial?limite=50&offset=0'
```

El primer POST devuelve 201; repetirlo devuelve 200 con `duplicado: true`. Ambos confirman almacenamiento. El ejemplo manual agrega un evento a la base local. El ejemplo usa hora desconocida; no debe mostrarse como una medición actual confirmada. En el servicio publicado las rutas protegidas requieren una clave o una sesión autorizada según el tipo de acceso.

## Contrato JSON v1

Todos los campos de `examples/evento.json` son obligatorios; campos adicionales se rechazan. Un POST contiene un evento, máximo 16 KiB.

| Campo | Regla |
| --- | --- |
| `version` | Entero 1. |
| `dispositivo_id`, `paso_id` | Deben existir en la tabla `tuneles` y corresponder a la clave usada. Inicialmente existe `esp32-01` / `tunel-01`; se agregan más desde el panel o `POST /api/tuneles`. Un dispositivo por paso. |
| `evento_id` | Identidad estable del evento; nunca generar otra para un reintento. Única por dispositivo. |
| `arranque_id` | Identidad del arranque, nueva tras cada reinicio. |
| `secuencia` | Entero creciente por dispositivo, **persistente entre reinicios**. No se ordena por hora de llegada ni por arranque. El firmware suma la base de instalación reservada por la API a su secuencia local persistente. |
| `uptime_ms` | Tiempo transcurrido desde arranque; informativo, no se usa para ordenar entre arranques. |
| `medido_en` | Fecha ISO 8601 con zona horaria, o `null` si no hay reloj sincronizado. Se normaliza a UTC. Más de 60 s en el futuro se rechaza. |
| `codigo`, `diagnostico` | Uno de los nueve códigos del firmware; texto de 1–200 caracteres. La API no reproduce la lógica temporal del ESP32. |
| `sensor1_valido`, `sensor2_valido` | Booleanos. |
| `obstruccion_carril1_cm`, `obstruccion_carril2_cm` | Número finito 0–398 para sensor válido, `null` para inválido. |
| `agua_activa`, `agua_pendiente` | Booleanos; no pueden ser ambos verdaderos. |

Los identificadores admiten 1–80 letras ASCII, números, guion o guion bajo. La secuencia y el uptime admiten 0 a 2^63−1. El backend registra por separado `recibido_en` en UTC.

## Estadísticas

`GET /api/pasos/<paso_id>/estadisticas?rango=1h|6h|24h|7d|all` devuelve un resumen calculado en el servidor: totales, tiempo por código (cada evento cuenta hasta 15 s o hasta el siguiente), bloques de actividad con el tiempo por severidad, la franja de estado y una serie de obstrucción reducida a 600 puntos que conserva el máximo de cada bloque. El panel ya no descarga el historial completo para esta vista. El resultado se guarda 10 s en memoria para que varios paneles compartan el cálculo.

## Entrega, orden y actualidad

`POST /api/dispositivos/esp32-01/reserva` recibe únicamente `{"instalacion_id":"<32 caracteres hexadecimales minúsculos>"}`. Reserva transaccionalmente un rango de 2^32 secuencias por instalación; una repetición devuelve la misma base. Una flash nueva utiliza una identidad nueva y obtiene un rango posterior, sin borrar eventos. Las tablas se crean de forma no destructiva. El firmware puede registrar offline antes de reservar; necesita la reserva para el primer envío de cada arranque. No exponer esta API sin autenticación fuera del entorno local.

- El ACK `guardado: true` se emite después del commit de SQLite. Un reintento idéntico no inserta ni cambia la fecha de recepción original.
- Identidad o secuencia reutilizada con otro contenido: 409. No descartar el evento automáticamente; requiere corregir el emisor.
- Datos inválidos: 400; contenido no JSON: 415; cuerpo excesivo: 413; fallo de almacenamiento: 503, sin ACK.
- El estado selecciona la mayor secuencia del paso, incluso si llegan eventos antiguos después.
- `comunicacion` usa la recepción de eventos nuevos: `recepcion_reciente` o `sin_comunicacion`, con umbral de 30 s. Repetir un duplicado no renueva esta señal.
- `actualidad_medicion` usa la fecha de medición: `reciente`, `desactualizada` o `desconocida`. Recibir un lote antiguo no lo vuelve actual. El umbral de 60 s se configura en `STALE_SECONDS`; el panel usa la misma tolerancia para que una pequeña desincronización no quite la vigencia antes de tiempo.
- `ultimo_estado_conocido` siempre es un dato histórico identificado. No interpretar `OK-001` como habilitación vigente si la medición está desactualizada o su actualidad es desconocida.
- Estado sin eventos: 404. Historial sin eventos: lista vacía. Historial ordenado por secuencia descendente; `limite` 1–200, `offset` no negativo.

## Pruebas

```bash
cd backend
.venv/bin/python -m unittest discover -s tests -v
```

Las pruebas usan bases temporales bajo `backend/.test-tmp`, sin alterar la base de uso normal. Cubren persistencia, contrato, duplicados, conflictos, actualidad, autenticación, separación de permisos, panel y límites de ritmo. No sustituyen la validación prolongada de Wokwi → HTTPS → Pi.
