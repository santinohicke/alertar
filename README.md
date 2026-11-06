# AlertAR

AlertAR es un prototipo de ciudad inteligente para monitorear pasos bajo nivel (túneles bajo las vías). En cada paso, un ESP32 mide dos carriles y la presencia de agua, evalúa el riesgo localmente, informa el estado con semáforo y pantalla LCD, y envía eventos a una API REST cuando tiene conexión. Un panel web muestra el estado en vivo de todos los pasos, su historial, estadísticas y un mapa de la ciudad.

**Repositorio:** [Agusttin-0/AlertAR](https://github.com/Agusttin-0/AlertAR) · **Panel publicado:** [homebase.tail5a3b96.ts.net:8443](https://homebase.tail5a3b96.ts.net:8443/) (requiere autenticación).

El repositorio contiene el firmware, el circuito de simulación, el backend Flask, el panel y los scripts de despliegue. No incluye claves, bases de datos, respaldos ni firmware compilado.

## Ramas

| Rama | Contenido |
|---|---|
| `main` | Proyecto real. Las claves de dispositivo se guardan solo como hash y se muestran una única vez. |
| `demo` | `main` más lo necesario para presentaciones: el panel muestra la clave de cada dispositivo y hay scripts para generar historial artificial y probar carga. No usar en un despliegue real. |

Los cambios del proyecto entran a `main` por pull request y después se integran en `demo` (nunca al revés).

## Cómo funciona

```text
Sensores ultrasónicos + sensor de agua
                  │
                  ▼
          ESP32 / lógica local ── LEDs, LCD y telemetría serie
                  │  cola persistente en LittleFS
                  │  HTTPS + JSON, clave exclusiva por dispositivo
                  ▼
        API Flask (gunicorn, servidor)
         ├─ validación, autenticación y límites de ritmo
         ├─ SQLite: eventos, pasos, reservas de secuencia
         └─ resúmenes de estado y estadísticas
                  │
                  ▼
     Panel web: Monitoreo · Historial · Estadísticas · Mapa
```

La decisión de seguridad no depende de Internet: el ESP32 procesa los sensores y actualiza las salidas localmente. La conexión agrega registro histórico y supervisión remota. Si la red o el servidor no están disponibles, los eventos pendientes se guardan en LittleFS y se reenvían cuando vuelve la comunicación.

## Subsistemas

### Firmware ESP32

El proyecto activo está en `AlertAR-2/` (C++ con Arduino Framework, compilado con PlatformIO).

- Dos sensores ultrasónicos estiman la altura de una obstrucción en cada carril; la lectura usa interrupciones para no bloquear el ciclo principal.
- Un sensor analógico detecta agua con histéresis y 20 s de confirmación.
- La lógica genera nueve códigos (`OK-001`, `INF-001`, `ERR-001` a `ERR-007`) según [tabla_logica.md](tabla_logica.md) y controla LEDs verde, amarillo y rojo y una pantalla LCD I2C.
- Envía una muestra cada 15 s y otra inmediata en cada cambio de estado. Detalles de transporte, cola y reintentos en [CONECTIVIDAD.md](CONECTIVIDAD.md).

### API REST

El backend de `backend/` valida el contrato JSON, autentica la ingesta, evita duplicados por identidad y secuencia, limita el ritmo de pedidos y separa la fecha de medición de la fecha de recepción. Guarda todo en SQLite. Contrato completo y variables de entorno en [backend/README.md](backend/README.md).

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/health` | Estado básico del servicio |
| `POST` | `/api/eventos` | Recibir un evento del ESP32 |
| `POST` | `/api/dispositivos/{id}/reserva` | Reservar secuencias para una instalación |
| `GET` | `/api/pasos/{id}/estado` | Último estado conocido y su vigencia |
| `GET` | `/api/pasos/{id}/historial` | Eventos anteriores, paginados |
| `GET` | `/api/pasos/{id}/estadisticas` | Resumen calculado en el servidor para un rango (`1h`, `6h`, `24h`, `7d`, `all`) |
| `GET` | `/api/panel/{id}` | Estado y últimos 20 eventos para el panel |
| `GET` `POST` | `/api/tuneles` | Listar pasos (con último código y última recepción) o crear uno con su clave |
| `PATCH` | `/api/tuneles/{id}` | Editar nombre, ubicación y coordenadas |
| `POST` | `/api/tuneles/{id}/clave` | Reemplazar la clave de dispositivo (la anterior deja de valer) |
| `DELETE` | `/api/tuneles/{id}` | Borrar un paso, su clave, sus eventos y sus reservas (`tunel-01` no se borra) |

### Panel web

El panel muestra todos los pasos en una barra lateral, cada uno con su luz de estado, y cuatro pestañas: **Monitoreo** (estado vigente, lecturas, eventos recientes y datos del dispositivo), **Historial** (registros paginados y exportación CSV/JSON), **Estadísticas** (tiempo por estado, actividad y obstrucción en un rango) y **Mapa** (mapa esquemático de CABA con los pasos coloreados por estado). Cómo decide cada color, cómo se calculan las estadísticas y cómo funcionan el mapa y las animaciones está en [PANEL.md](PANEL.md).

### Servidor

El servicio publicado corre en un servidor Linux con gunicorn (un proceso, 16 hilos) como servicio de usuario de systemd, expuesto con Tailscale Funnel en el puerto 8443. Instrucciones en [deploy/servidor/README.md](deploy/servidor/README.md). La instalación anterior en una Raspberry Pi sigue disponible en `deploy/raspi/` con límites más bajos; ver [PANEL_RASPBERRY.md](PANEL_RASPBERRY.md).

### Varios pasos y claves por dispositivo

Cada paso tiene su propio `paso_id`, `dispositivo_id`, nombre, ubicación, coordenadas y clave de dispositivo. La clave se genera al crear el paso desde **Agregar paso a nivel** en el panel, donde la ubicación se marca tocando el mapa (las coordenadas exactas están en *Opciones avanzadas*). Se muestra una sola vez y se guarda solo como hash. Una clave únicamente puede enviar datos de su paso; con otro `paso_id` o `dispositivo_id` el servidor responde 403. Un paso se borra desde el pie del panel **Dispositivo**, con confirmación.

Para sumar un ESP32: crear el paso en el panel, copiar la clave, y en el firmware poner esa clave en `conectividad_secrets.h`, el `dispositivo_id` en la URL de reserva y los IDs en `DISPOSITIVO` y `PASO` de `src/conectividad_config.h`. Hay que volver a compilar antes de iniciar el simulador.

`backend/simulador.py` es un simulador por línea de comandos que envía telemetría de prueba con la clave de `ALERTAR_API_KEY` o `--key`. Los endpoints `/api/simulador/*` están deshabilitados salvo con `ALERTAR_ENABLE_SIMULATOR=1`; no activarlo en el servidor publicado.

## Ejecutar la simulación

### Requisitos

- Visual Studio Code con las extensiones PlatformIO IDE y Wokwi Simulator.
- Git.

### Preparación

1. Clonar el repositorio y abrir la carpeta `AlertAR-2` en Visual Studio Code.
2. Crear la configuración local a partir de la plantilla:

   ```bash
   cp include/conectividad_secrets.example.h include/conectividad_secrets.h
   ```

3. Para probar solamente sensores, LEDs y LCD, dejar `ALERTAR_CONECTIVIDAD_HABILITADA` en `false`.
4. Para conectarse al servidor, completar la clave de dispositivo del paso y cambiar la opción a `true`. La plantilla contiene la URL del servidor publicado. La URL de reserva y los valores `DISPOSITIVO` y `PASO` de `src/conectividad_config.h` deben corresponder al paso de esa clave.
5. Ejecutar **PlatformIO: Build** y luego **Wokwi: Start Simulator**. Wokwi no recompila: tras cualquier cambio hay que volver a compilar.

`include/conectividad_secrets.h` es local y está ignorado por Git.

Si la computadora se suspende con la simulación abierta, el ESP32 simulado deja de sincronizar la hora (NTP cada 5 minutos) y al volver envía su cola con atraso. El panel muestra esas mediciones como desactualizadas hasta que lleguen datos nuevos; es el comportamiento esperado.

## Estructura

```text
AlertAR-2/                       firmware y circuito de Wokwi
├── include/conectividad_secrets.example.h
└── src/                         lógica, sensores, conectividad, cola y protocolo
tests/                           pruebas nativas C++ de lógica y protocolo
backend/
├── app.py                       API, contrato y almacenamiento
├── panel.py                     panel, autenticación, límites y gestión de pasos
├── estadisticas.py              resumen de estadísticas por paso y rango
├── templates/, static/          panel web (HTML, CSS y JS sin dependencias externas)
├── simulador.py                 simulador por línea de comandos
└── tests/                       pruebas de API, panel, estadísticas y límites
deploy/servidor/                 despliegue en servidor (systemd + gunicorn)
deploy/raspi/                    despliegue en la Raspberry Pi y watchdog de Tailscale
tabla_logica.md                  tabla funcional de estados
PANEL.md                         funcionamiento del panel
CONECTIVIDAD.md                  transporte del ESP32 y límites
IMPLEMENTACION.md                componentes, alcance y validación
PANEL_RASPBERRY.md               instalación en la Raspberry Pi
```

Para ejecutar la API en desarrollo local, ver [backend/README.md](backend/README.md). Ese modo no exige autenticación y debe permanecer en `127.0.0.1`.

## Seguridad antes de publicar

- No agregar `conectividad_secrets.h`, archivos `.env`, claves privadas, bases SQLite, respaldos, registros de diagnóstico ni binarios compilados.
- No publicar firmware `.bin` o `.elf`: una credencial puede quedar incorporada dentro del binario.
- Ejecutar `bash scripts/verificar_secretos.sh` antes de cada push. GitHub Actions repite ese control en cada push y pull request.
- Si una credencial llega a un commit, debe revocarse y reemplazarse; borrarla en un commit posterior no elimina la copia del historial.

## Pruebas

- `tests/`: lógica de estados, cola y contrato del firmware (C++).
- `backend/tests/`: 45 pruebas de API, panel, autenticación, estadísticas, borrado y límites de ritmo (`.venv/bin/python -m unittest discover -s tests` desde `backend/`).
