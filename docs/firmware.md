# Firmware del ESP32: sensores, lógica y salidas

El firmware está en `AlertAR-2/` (C++ con Arduino Framework, compilado con PlatformIO para la placa `esp32dev`). Cada paso a nivel tiene un ESP32 que mide, decide el estado y lo muestra **sin depender de Internet**. El envío al servidor es una capa aparte, descrita en [conectividad.md](conectividad.md).

| Archivo | Responsabilidad |
|---|---|
| `src/main.cpp` | Pines, inicio, ciclo principal, LEDs, LCD y telemetría por puerto serie |
| `src/logica.h` | Validez de lecturas, altura, agua con histéresis, persistencia y decisión del código |
| `src/ultrasonido.*` | Medición ultrasónica por interrupciones |
| `src/conectividad.*`, `registro.h`, `protocolo.h` | Envío de eventos (ver conectividad.md) |
| `diagram.json` | Circuito de Wokwi |

## Hardware

| Elemento | Pines del ESP32 | Detalle |
|---|---|---|
| Ultrasónico carril 1 | TRIG 26, ECHO 25 | HC-SR04 |
| Ultrasónico carril 2 | TRIG 19, ECHO 21 | HC-SR04 |
| Sensor de agua | 34 (entrada analógica) | En Wokwi es un potenciómetro deslizante |
| LED verde / amarillo / rojo | 17 / 5 / 18 | Con resistencias de 1 kΩ |
| Pantalla LCD 16×2 | I2C en SDA 32, SCL 33 | Dirección 0x27 |

El puerto serie trabaja a 115200 baudios.

## Medición de cada carril

1. El ESP32 envía un pulso de 10 µs al TRIG.
2. Una interrupción en el pin ECHO registra los flancos de subida y bajada con el temporizador de alta resolución (`esp_timer_get_time`). La medición espera el eco como máximo 30 ms, sin bloquear el resto del sistema con `pulseIn`.
3. Distancia = duración × 0,0343 / 2 (velocidad del sonido en cm/µs, ida y vuelta).
4. La lectura es **válida** si la distancia está entre 2 y 410 cm. Sin eco, eco fuera de tiempo o fuera de ese rango, el carril queda inválido.
5. Altura de la obstrucción = 400 cm (altura de montaje del sensor) − distancia, con mínimo 0. Un auto bajo el sensor da una altura cercana a su altura real.

Se mide un carril, se esperan 60 ms (para que el eco de uno no interfiera con el otro), se mide el otro, y el ciclo completo dura entre 260 y 320 ms.

## Agua

El sensor analógico se lee en cada ciclo (0–4095):

- Por encima de **2000** se considera agua; en **1800 o menos**, seco. Entre ambos valores se conserva la lectura anterior (histéresis), para que una señal en el límite no oscile.
- El agua **se confirma** después de **20 s** continuos y **se libera** después de 20 s continuos de seco.
- Mientras el agua está detectada pero no confirmada, el estado es *pendiente* (`agua_pendiente`).

## Ocupación y persistencia

- Un carril está **ocupado** si su altura supera **5 cm**; la ocupación es **alta** si supera **100 cm**.
- El tiempo de ocupación solo se suma entre dos lecturas válidas consecutivas y se satura en 60 s.
- Una ocupación es **persistente** después de **60 s**. Antes de eso es *transitoria* (un vehículo que pasa): si el carril se libera, el contador vuelve a cero de inmediato, así no se suman vehículos sucesivos.
- Una ocupación ya persistente necesita **3 s** de lecturas libres para retirarse.
- Mientras una lectura es inválida, el estado se conserva y el tiempo no avanza.

## Decisión del estado

`decidir()` en `logica.h` evalúa en este orden y se queda con la primera regla que se cumple. La tabla completa, con ejemplos, está en [tabla_logica.md](tabla_logica.md).

| Prioridad | Condición | Código | LED | LCD |
|---|---|---|---|---|
| 1 | Agua confirmada | `ERR-001` | Rojo | PASO CERRADO / Agua critica |
| 2 | Algún sensor ultrasónico inválido | `ERR-003` | Amarillo | PRECAUCION / Falla de sensor |
| 3 | Ambos carriles con ocupación persistente | `ERR-005` | Rojo | PASO CERRADO / Ambos bloqueados |
| 4 | Agua pendiente de confirmación | `ERR-002` | Amarillo | PRECAUCION / Verificando agua |
| 5 | Ambos ocupados y alguno persistente | `ERR-004` | Amarillo | PRECAUCION / Obstruccion |
| 6 | Uno ocupado con ocupación alta persistente | `ERR-006` | Amarillo | PRECAUCION / Carril bloqueado |
| 7 | Uno ocupado con ocupación persistente | `ERR-007` | Amarillo | PRECAUCION / Obstruccion |
| 8 | Algún carril ocupado, ninguno persistente | `INF-001` | Verde | Paso habilitado / Transitorio |
| 9 | Ambos libres | `OK-001` | Verde | Paso habilitado |

Si ninguna regla aplica (no debería pasar), el firmware usa `ERR-002` con el diagnóstico "Situacion no clasificada" y LED amarillo, como salida defensiva.

## Salidas locales

- **LEDs:** verde para `OK-001` e `INF-001`; amarillo para `ERR-002`, `003`, `004`, `006` y `007`; rojo para `ERR-001` y `ERR-005`. Es la misma severidad que usa el panel.
- **LCD:** dos líneas con la señal y el motivo. Solo se redibuja cuando cambia el texto, para que no parpadee.
- **Puerto serie:** una línea JSON con `codigo`, `diagnostico`, alturas de cada carril (`null` si el sensor es inválido), validez de cada sensor, `agua_activa` y `agua_pendiente`. Se emite al cambiar el código, el diagnóstico, el color, el agua o la validez de un sensor, y cada 5 s como mínimo. Sirve para seguir la simulación en el monitor serie; el envío al servidor es independiente.

## Inicio y ciclo principal

`setup()` configura el puerto serie, los pines, los LEDs, el bus I2C y la LCD, inicia la medición ultrasónica y, si `ALERTAR_CONECTIVIDAD_HABILITADA` es `true`, la conectividad.

Durante los primeros **2 s** el equipo muestra "PRECAUCION / Iniciando..." con el LED amarillo y no decide ningún estado. Después, cada ciclo de `loop()`:

1. Atiende comandos de conectividad por el puerto serie.
2. Lee el agua y actualiza su confirmación.
3. Mide el carril 1, espera 60 ms y mide el carril 2.
4. Decide el estado con `decidir()`.
5. Actualiza LEDs y LCD y, si corresponde, emite la telemetría serie.
6. Entrega el estado a la conectividad (`conectividad::observar`), que decide si genera un evento para el servidor.
7. Espera 200 ms.

## Pruebas

`tests/logica_test.cpp` recorre 2.700 combinaciones de lecturas y tiempos y comprueba el código que corresponde a cada una según la tabla. Se compila y ejecuta en la computadora, sin placa.
