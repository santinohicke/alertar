# AlertAR

AlertAR es un prototipo de ciudad inteligente para monitorear un paso bajo nivel. Un ESP32 toma mediciones de dos carriles y de presencia de agua, evalúa el riesgo localmente, informa el estado mediante semáforo y pantalla LCD, y envía eventos a una API REST cuando tiene conexión.

**Repositorio:** [Agusttin-0/AlertAR](https://github.com/Agusttin-0/AlertAR) · **Panel público:** [raspi.tail5a3b96.ts.net](https://raspi.tail5a3b96.ts.net/) (requiere autenticación).

El repositorio contiene el firmware, el circuito de simulación, el backend Flask, el panel y los scripts de despliegue. No incluye claves API, bases de datos, respaldos ni firmware compilado. La API FastAPI anterior que ya estaba instalada en la Raspberry Pi no forma parte de este proyecto; el adaptador de `deploy/raspi/` se integra con ella.

## Cómo funciona

```text
Sensores ultrasónicos + sensor de agua
                  │
                  ▼
          ESP32 / lógica local
         ├─ LEDs y pantalla LCD
         ├─ telemetría por puerto serie
         └─ cola persistente en LittleFS
                  │ HTTPS + JSON
                  ▼
              API REST
         ├─ validación y autenticación
         ├─ almacenamiento en SQLite
         └─ estado, historial y panel web
```

La decisión de seguridad no depende de Internet: el ESP32 procesa los sensores y actualiza las salidas localmente. La conexión agrega registro histórico y supervisión remota. Si la red o el servidor no están disponibles, los eventos pendientes se guardan en LittleFS y se reenvían cuando vuelve la comunicación.

## Subsistemas y tecnologías

### Firmware ESP32

El proyecto activo está en `AlertAR-2/` y usa C++ con Arduino Framework, compilado con PlatformIO.

- Dos sensores ultrasónicos estiman la altura de una obstrucción en cada carril.
- Un sensor analógico detecta agua con histéresis y tiempos de confirmación para evitar cambios espurios.
- La lógica genera códigos `OK`, `INF` y `ERR`, y controla LEDs verde, amarillo y rojo y una pantalla LCD I2C.
- La lectura ultrasónica se realiza con interrupciones para no bloquear el ciclo principal.
- La telemetría de diagnóstico se emite como JSON por el puerto serie.

### Persistencia y conectividad

- Wi-Fi para Wokwi mediante `Wokwi-GUEST`.
- HTTPS con validación del certificado del servidor; no se usa una conexión TLS insegura.
- Eventos JSON con identificador y secuencia para que los reintentos sean idempotentes.
- Cola persistente en LittleFS para tolerar cortes de red o del servidor.
- Reintentos con espera progresiva y respeto de respuestas `429`, `503` y `Retry-After`.
- Tareas separadas de FreeRTOS para registro y transmisión, sin detener la lógica de sensores.

### Simulación con Wokwi

`AlertAR-2/diagram.json` describe el circuito simulado y `AlertAR-2/wokwi.toml` indica a Wokwi qué firmware y archivo ELF debe cargar. PlatformIO instala las bibliotecas declaradas, compila el firmware y genera la imagen fusionada usada por el simulador.

La simulación permite cambiar las distancias y el nivel de agua, observar LEDs y LCD, y revisar los JSON de estado y conectividad en el monitor serie.

### API REST y servidor

El servicio publicado se ejecuta en una Raspberry Pi. La aplicación usa Flask para las rutas modernas y el panel, conserva compatibilidad con una API FastAPI anterior mediante un adaptador ASGI y se sirve con Uvicorn. Los eventos se almacenan en SQLite. El código de esa API anterior no está incluido aquí.

La API se expone en [https://raspi.tail5a3b96.ts.net/](https://raspi.tail5a3b96.ts.net/) mediante Tailscale Funnel. El firmware usa una clave exclusiva y limitada a ingesta; la clave administrativa del panel nunca se instala en el ESP32. La URL es pública, pero ninguna clave está incluida en el repositorio.

Interfaz principal:

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/health` | Estado básico del servicio |
| `POST` | `/api/eventos` | Recibir un evento del ESP32 |
| `POST` | `/api/dispositivos/{id}/reserva` | Reservar secuencias para una instalación |
| `GET` | `/api/pasos/{id}/estado` | Consultar el último estado conocido |
| `GET` | `/api/pasos/{id}/historial` | Consultar eventos anteriores |
| `GET` | `/api/panel/{id}` | Datos acotados para el panel |
| `GET` `POST` | `/api/tuneles` | Listar pasos o crear uno nuevo con su clave de dispositivo y ubicación |
| `PATCH` | `/api/tuneles/{id}` | Editar nombre, ubicación y coordenadas |
| `POST` | `/api/tuneles/{id}/clave` | Reemplazar la clave de dispositivo (la anterior deja de valer) |
| `DELETE` | `/api/tuneles/{id}` | Eliminar un paso y sus eventos (`tunel-01` no se elimina) |

### Varios pasos a nivel y claves por dispositivo

Cada paso tiene su propio `paso_id`, `dispositivo_id`, nombre, ubicación y coordenadas, y su propia clave de dispositivo. La clave se genera al crear el paso (botón "+ Nuevo Túnel" del panel), se muestra una sola vez y se guarda solo como hash. Una clave únicamente puede enviar datos de su paso; con otro `paso_id` o `dispositivo_id` el servidor responde 403. Si el paso tiene coordenadas, el panel muestra un enlace a su ubicación en el mapa.

Para sumar un ESP32: crear el paso en el panel, copiar la clave, y en el firmware poner esa clave en `conectividad_secrets.h` y los IDs del paso en `DISPOSITIVO` y `PASO` de `src/conectividad_config.h`, y en la URL de reserva. Hay que volver a compilar antes de iniciar el simulador.

`backend/simulador.py` es un simulador por línea de comandos que envía telemetría de prueba; usa la clave de la variable `ALERTAR_API_KEY` o `--key`. Los endpoints `/api/simulador/*` están deshabilitados salvo con `ALERTAR_ENABLE_SIMULATOR=1`; no activarlo en el servidor publicado.

El backend en `backend/` valida el contrato JSON, autentica la ingesta, evita duplicados por identidad y secuencia, limita la frecuencia de solicitudes y separa la fecha de medición de la fecha de recepción. La API publicada requiere autenticación; la URL por sí sola no permite escribir eventos ni leer el historial.

## Ejecutar la simulación

### Requisitos

- Visual Studio Code.
- Extensiones PlatformIO IDE y Wokwi Simulator.
- Git.

### Preparación

1. Clonar el repositorio y abrir la carpeta `AlertAR-2` en Visual Studio Code.
2. Crear la configuración local a partir de la plantilla:

   ```bash
   cp include/conectividad_secrets.example.h include/conectividad_secrets.h
   ```

3. Para probar solamente sensores, LEDs y LCD, dejar `ALERTAR_CONECTIVIDAD_HABILITADA` en `false`.
4. Para conectar una instancia autorizada del servidor, completar en el archivo local la clave de dispositivo entregada por el administrador y cambiar la opción a `true`. La plantilla contiene la URL pública de AlertAR. La URL de reserva y los valores `DISPOSITIVO` y `PASO` de `src/conectividad_config.h` deben corresponder al paso al que pertenece la clave.
5. Ejecutar **PlatformIO: Build** y luego **Wokwi: Start Simulator** desde la paleta de comandos. Wokwi no recompila: tras cualquier cambio en el código hay que volver a compilar.

El archivo `include/conectividad_secrets.h` es local y está ignorado por Git. La plantilla pública no contiene valores utilizables.

## Estructura pública

```text
AlertAR-2/
├── diagram.json                 circuito de Wokwi
├── platformio.ini               placa, framework y dependencias
├── wokwi.toml                   configuración del simulador
├── include/
│   └── conectividad_secrets.example.h
├── scripts/merge_firmware.py    imagen fusionada para Wokwi
└── src/
    ├── main.cpp                 sensores, LCD, LEDs y ciclo principal
    ├── logica.h                 reglas y códigos de estado
    ├── ultrasonido.*            medición no bloqueante
    ├── conectividad.*           Wi-Fi, HTTPS y tareas de envío
    ├── conectividad_config.h    parámetros no secretos
    ├── registro.h               cola persistente
    ├── protocolo.h              contrato y confirmaciones
    └── certificado.h            autoridad certificante pública
tests/                           pruebas nativas de lógica y protocolo
backend/                         API Flask, panel, simulador CLI, ejemplo y pruebas
deploy/raspi/                    adaptador, instalación y watchdog de la Pi
tabla_logica.md                  tabla funcional de estados
CONECTIVIDAD.md                  transporte y límites conocidos
IMPLEMENTACION.md                componentes y alcance
PANEL_RASPBERRY.md               despliegue y validación pendiente
```

Para ejecutar la API en desarrollo local, ver [backend/README.md](backend/README.md). Ese modo no exige autenticación y debe permanecer en `127.0.0.1`. La instalación de la Pi requiere su API FastAPI anterior; ver [PANEL_RASPBERRY.md](PANEL_RASPBERRY.md).

## Seguridad antes de publicar

- No agregar `conectividad_secrets.h`, archivos `.env`, claves privadas, bases SQLite, respaldos, registros de diagnóstico ni binarios compilados.
- No publicar firmware `.bin` o `.elf`: una credencial puede quedar incorporada dentro del binario.
- Ejecutar `bash scripts/verificar_secretos.sh` antes de cada push.
- GitHub Actions repite ese control en cada push y pull request.
- Si una credencial llega a un commit, debe revocarse y reemplazarse; borrarla en un commit posterior no elimina la copia del historial.

## Pruebas

Las pruebas C++ de `tests/` verifican la lógica de estados, el orden y la capacidad de la cola y el contrato de comunicación. Los ejecutables generados y las evidencias locales no forman parte del repositorio.

