# AlertAR

AlertAR es un prototipo de ciudad inteligente para monitorear un paso bajo nivel. Un ESP32 toma mediciones de dos carriles y de presencia de agua, evalúa el riesgo localmente, informa el estado mediante semáforo y pantalla LCD, y envía eventos a una API REST cuando tiene conexión.

El repositorio público contiene el firmware, el circuito de simulación y las pruebas de la lógica. **El código del servidor, su configuración, la base de datos y las credenciales no se publican por el momento.**

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

El servidor actual se ejecuta fuera de este repositorio en una Raspberry Pi. La aplicación usa Flask para las rutas modernas y el panel, conserva compatibilidad con una API FastAPI anterior mediante un adaptador ASGI y se sirve con Uvicorn. Los eventos se almacenan en SQLite.

La API se expone por HTTPS mediante Tailscale Funnel. El firmware usa una clave exclusiva y limitada a ingesta; la clave administrativa del panel nunca se instala en el ESP32. No se publica aquí el nombre real del servidor ni ninguna clave.

Interfaz principal, sin incluir el dominio privado:

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/health` | Estado básico del servicio |
| `POST` | `/api/eventos` | Recibir un evento del ESP32 |
| `POST` | `/api/dispositivos/{id}/reserva` | Reservar secuencias para una instalación |
| `GET` | `/api/pasos/{id}/estado` | Consultar el último estado conocido |
| `GET` | `/api/pasos/{id}/historial` | Consultar eventos anteriores |

El backend valida el contrato JSON, autentica la ingesta, evita duplicados por identidad y secuencia, limita la frecuencia de solicitudes y separa la fecha de medición de la fecha de recepción. Su código se incorporará más adelante cuando esté listo para publicación.

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
4. Para conectar una instancia autorizada del servidor, completar en el archivo local las dos URLs HTTPS y la clave de dispositivo entregada por el administrador, y cambiar la opción a `true`.
5. Ejecutar **PlatformIO: Build** y luego **Wokwi: Start Simulator** desde la paleta de comandos.

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
tabla_logica.md                  tabla funcional de estados
```

La carpeta `AlertAR/` conserva la primera versión del circuito y del sketch como referencia. El desarrollo y la simulación actuales se realizan en `AlertAR-2/`.

## Seguridad antes de publicar

- No agregar `conectividad_secrets.h`, archivos `.env`, claves privadas, bases SQLite, respaldos ni binarios compilados.
- No publicar firmware `.bin` o `.elf`: una credencial puede quedar incorporada dentro del binario.
- Ejecutar `bash scripts/verificar_secretos.sh` antes de cada push.
- GitHub Actions repite ese control en cada push y pull request.
- Si una credencial llega a un commit, debe revocarse y reemplazarse; borrarla en un commit posterior no elimina la copia del historial.

## Pruebas

Las pruebas C++ de `tests/` verifican la lógica de estados, el orden y la capacidad de la cola y el contrato de comunicación. Los ejecutables generados y las evidencias locales no forman parte del repositorio.

## Estado del proyecto

AlertAR es un prototipo académico y de simulación. Las mediciones de Wokwi y las pruebas de software no sustituyen validación eléctrica, ambiental ni de seguridad vial sobre hardware real.
