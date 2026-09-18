# Backend local de AlertAR — pasos 1 y 2

API Flask y SQLite para la simulación. El firmware AlertAR-2 ahora envía HTTP y registra pendientes en LittleFS. Ver `../CONECTIVIDAD.md` para los pasos 3–5 y las pruebas pendientes. No incluye panel web ni integración municipal/Waze.

## Iniciar

Desde una terminal de VS Code:

```bash
cd "/Users/agustinbravo/Documents/Documentos Agustin/Ciudad_Inteligente/backend"
source .venv/bin/activate
flask --app app run --host=127.0.0.1 --port=5001
```

El entorno virtual ya está instalado. Para recrearlo: `python3 -m venv .venv` y `.venv/bin/python -m pip install -r requirements.txt`. La aplicación crea automáticamente las tablas si no existen, sin borrar datos. SQLite se guarda en `backend/instance/alertar.sqlite3`, independientemente del directorio desde el que se ejecute Flask. No requiere otro proceso.

El servidor es solo de desarrollo local, sin autenticación. Al conectar Wokwi en el paso 3 se verificará acceso mediante `http://host.wokwi.internal:5001`; si el gateway requiere escuchar en otras interfaces se ajustará el bind. No publicar este servidor en Internet.

## Probar manualmente

En otra terminal, desde la carpeta backend:

```bash
curl http://127.0.0.1:5001/health
curl -i -H 'Content-Type: application/json' --data-binary @examples/evento.json http://127.0.0.1:5001/api/eventos
curl http://127.0.0.1:5001/api/pasos/tunel-01/estado
curl 'http://127.0.0.1:5001/api/pasos/tunel-01/historial?limite=50&offset=0'
```

El primer POST devuelve 201; repetirlo devuelve 200 con `duplicado: true`. Ambos confirman almacenamiento. El ejemplo manual sí agrega un evento a la base local. El ejemplo usa hora desconocida; no debe mostrarse como una medición actual confirmada.

## Contrato JSON v1

Todos los campos de `examples/evento.json` son obligatorios; campos adicionales se rechazan. Un POST contiene un evento, máximo 16 KiB.

| Campo | Regla |
| --- | --- |
| `version` | Entero 1. |
| `dispositivo_id`, `paso_id` | Configuración inicial: `esp32-01` y `tunel-01`. Un dispositivo por paso. El mapa `DISPOSITIVOS` se configura en la aplicación. |
| `evento_id` | Identidad estable del evento; nunca generar otra para un reintento. Única por dispositivo. |
| `arranque_id` | Identidad del arranque, nueva tras cada reinicio. |
| `secuencia` | Entero creciente por dispositivo, **persistente entre reinicios**. No se ordena por hora de llegada ni por arranque. Reservar/persistir secuencias en el firmware del paso 4. No reutilizar secuencias al borrar la flash: requerirá una nueva identidad de dispositivo y actualización de su registro. |
| `uptime_ms` | Tiempo transcurrido desde arranque; informativo, no se usa para ordenar entre arranques. |
| `medido_en` | Fecha ISO 8601 con zona horaria, o `null` si no hay reloj sincronizado. Se normaliza a UTC. Más de 60 s en el futuro se rechaza. |
| `codigo`, `diagnostico` | Uno de los nueve códigos del firmware; texto de 1–200 caracteres. La API no reproduce la lógica temporal del ESP32. |
| `sensor1_valido`, `sensor2_valido` | Booleanos. |
| `obstruccion_carril1_cm`, `obstruccion_carril2_cm` | Número finito 0–398 para sensor válido, `null` para inválido. |
| `agua_activa`, `agua_pendiente` | Booleanos; no pueden ser ambos verdaderos. |

Los identificadores admiten 1–80 letras ASCII, números, guion o guion bajo. La secuencia y el uptime admiten 0 a 2^63−1. El backend registra por separado `recibido_en` en UTC.

## Entrega, orden y actualidad

- El ACK `guardado: true` se emite después del commit de SQLite. Un reintento idéntico no inserta ni cambia la fecha de recepción original.
- Identidad o secuencia reutilizada con otro contenido: 409. No descartar el evento automáticamente; requiere corregir el emisor.
- Datos inválidos: 400; contenido no JSON: 415; cuerpo excesivo: 413; fallo de almacenamiento: 503, sin ACK.
- El estado selecciona la mayor secuencia del paso, incluso si llegan eventos antiguos después.
- `comunicacion` usa la recepción de eventos nuevos: `recepcion_reciente` o `sin_comunicacion`, con umbral de 30 s. Repetir un duplicado no renueva esta señal.
- `actualidad_medicion` usa la fecha de medición: `reciente`, `desactualizada` o `desconocida`. Recibir un lote antiguo no lo vuelve actual. El umbral de 30 s se configura en `STALE_SECONDS`.
- `ultimo_estado_conocido` siempre es un dato histórico identificado. No interpretar `OK-001` como habilitación vigente si la medición está desactualizada o su actualidad es desconocida.
- Estado sin eventos: 404. Historial sin eventos: lista vacía. Historial ordenado por secuencia descendente; `limite` 1–200, `offset` no negativo.

## Pruebas

```bash
cd "/Users/agustinbravo/Documents/Documentos Agustin/Ciudad_Inteligente/backend"
.venv/bin/python -m unittest discover -s tests -v
```

Las pruebas usan bases temporales bajo `backend/.test-tmp`, sin alterar la base de uso normal. Cubren persistencia al recrear la app, validación, duplicados concurrentes, conflictos, eventos atrasados, actualidad, errores HTTP y fallos de almacenamiento.
