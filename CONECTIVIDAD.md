# Conectividad — punto de reanudación

## Estado al cierre del 18/09/2026

Implementados los pasos 3, 4 y 5 en `AlertAR-2`. Se comprobó envío real desde Wokwi a Flask: SQLite contenía 20 eventos, secuencias 0–19, al verificar a las 16:30 UTC. El usuario confirmó que la simulación funciona y se pausa al perder el foco. Mantener visible la pestaña del simulador durante las pruebas.

La prueba integral de corte/reconexión y reinicio con pendientes se deja para la próxima sesión a pedido del usuario. No confundir implementación y pruebas automáticas con validación completa en hardware.

## Implementación

- `src/conectividad.cpp`: tareas de registro y envío en core 0; el loop de sensores/LED/LCD conserva su lógica en core 1. La entrega a la cola RAM usa timeout cero. Las operaciones de flash pueden introducir latencias propias del hardware; no es una certificación de tiempo real.
- `src/conectividad_config.h`: Wi-Fi Wokwi-GUEST, API `http://host.wokwi.internal:5001/api/eventos`, dispositivo esp32-01, paso tunel-01. Registro al cambiar código/validez/estado de agua y muestra cada 10 segundos.
- `src/registro.h`: un JSON por archivo `.log` en `/pendientes`. Escritura en temporal, comprobación de lectura y rename para publicar. Un temporal incompleto nunca se envía. No hay un único log creciente: se segmenta por evento para acotar espacio y evitar compactaciones grandes.
- Máximo 128 eventos persistentes pendientes, 64 muestras en RAM y una muestra en procesamiento. Al llenarse se conservan los pendientes; las nuevas muestras que no entran en RAM incrementan `descartados`. La retención offline no es ilimitada (128 muestras periódicas equivalen aproximadamente a 21 minutos; los cambios de estado consumen capacidad adicional).
- HTTP fuera del mutex de flash y del loop de control. Timeout de conexión/lectura de 2 segundos y reintentos de 1 a 32 segundos. Solo un ACK 200/201, con `guardado: true` booleano y la identidad correcta, permite mover el registro a `/enviados`. Se conservan los 16 últimos enviados; se borran únicamente los enviados más antiguos.
- `src/protocolo.h`: JSON y verificación de ACK compartidos con pruebas nativas. Secuencias reservadas en NVS en bloques de 1024 antes de utilizarlas. Reiniciar salta al siguiente bloque; los huecos son normales. Los reintentos conservan exactamente el JSON original.
- La hora se intenta sincronizar por NTP. Antes de sincronizar, `medido_en` es null; un evento guardado no se refecha posteriormente.
- LittleFS se monta sin autoformatear. Solo se formatea una partición comprobada completamente virgen. Un fallo de montaje sobre datos existentes detiene el registro y se informa, conservando la lógica local.
- `partitions.csv`: aplicación de 1,5 MiB y LittleFS de 0x270000 bytes, sin segunda partición OTA. `scripts/merge_firmware.py` genera la imagen completa que carga `wokwi.toml`.
- No se modificó `logica.h`, el circuito ni la versión alternativa `AlertAR`. El proyecto activo es `AlertAR-2`.

## Arranque

```bash
cd "/Users/agustinbravo/Documents/Documentos Agustin/Ciudad_Inteligente/backend"
.venv/bin/flask --app app run --host=127.0.0.1 --port=5001
```

Abrir `AlertAR-2` en VS Code, compilar con PlatformIO y comenzar Wokwi. Se verificó que el gateway llega a Flask escuchando solo en 127.0.0.1; no fue necesario exponerlo a la LAN. El servidor iniciado durante esta sesión puede seguir activo; si el puerto está ocupado, comprobarlo antes de iniciar otro.

Consultar estado: `http://127.0.0.1:5001/api/pasos/tunel-01/estado`. Historial: `http://127.0.0.1:5001/api/pasos/tunel-01/historial`. No hay página gráfica todavía.

## Diagnóstico y controles

El monitor serie conserva el JSON original por ciclo y agrega cada 5 s otro objeto con `tipo: conectividad`. Un consumidor del puerto serie debe distinguir ambos tipos. La API recibe solamente el contrato de eventos, no estos mensajes de diagnóstico.

- `wifi`: conexión a la red.
- `almacen`: 0 iniciando, 1 listo, 2 lleno, 3 error de almacenamiento, 4 fallo al crear tareas.
- `pendientes`, `cola_ram`, `confirmados`, `descartados`, `errores`: contadores/estado del arranque actual; los pendientes se reconstruyen del disco.
- `ultimo_http`: 201 nuevo, 200 duplicado aceptado, 409 conflicto de identidad; valores negativos indican fallo de red o registro. 400/409 conservan el evento y se reintentan: requieren revisar el origen, no se descartan silenciosamente.

Enviar desde el terminal serie de Wokwi: `0` para desconectar Wi-Fi, `1` para reconectar, `r` para reiniciar el ESP32. Estos son controles de ensayo. Un reinicio puede perder muestras que todavía estén solo en RAM.

## Verificado

- Firmware compilado para ESP32, con imagen fusionada para Wokwi.
- 12 pruebas Python aprobadas, incluyendo compatibilidad con el serializador C++ real.
- Pruebas C++ de cola: orden, duplicados, capacidad, retención, escritura incompleta, fallo de rename y reconstrucción de la cola sobre almacenamiento conservado.
- Pruebas C++ de protocolo: ACK inválido/incorrecto, secuencia persistida antes de uso, reserva fallida, salto tras reinicio y agotamiento.
- Comunicación real Wokwi → Flask → SQLite: 20 eventos al cierre de la comprobación. No se borraron estos datos de simulación.

## Retomar aquí

1. Con Wokwi visible, revisar `almacen`, pendientes y confirmados. Revisar que los pendientes bajan a cero con Flask disponible.
2. Detener Flask, cambiar agua/sensores, comprobar LED/LCD y aumento de pendientes; levantar Flask y verificar recuperación sin duplicados.
3. Repetir cortando Wi-Fi con `0` y recuperando con `1`.
4. Con pendientes guardados, enviar `r` y comprobar recuperación LittleFS/NVS y secuencias sin reutilización.
5. Probar detener y volver a iniciar Wokwi por separado: **no está verificado que conserve la flash entre sesiones**. Si Wokwi vuelve a cargar flash virgen, no equivale al reinicio de una placa. Puede reutilizar secuencias frente a una base existente y producir 409; no borrar el historial ni autoaceptar el conflicto. Resolver persistencia del simulador o un procedimiento explícito de reprovisionamiento antes de declarar esa prueba aprobada.
6. Probar límites de almacenamiento y fallos reales sobre hardware. La suite antigua `tests/logica_test.cpp` conserva el fallo preexistente de 400,1 cm frente al margen actual de 410 cm; no se alteró para ocultarlo.

Los pasos 6 (panel) y 7 (validación integral) del plan general siguen pendientes. No iniciar municipio/Waze.

## Repetir pruebas automáticas

Desde la raíz del proyecto:

```bash
c++ -std=c++11 tests/registro_test.cpp -o verificaciones/registro_test
verificaciones/registro_test
c++ -std=c++11 -I AlertAR-2/.pio/libdeps/esp32dev/ArduinoJson/src tests/protocolo_test.cpp -o verificaciones/protocolo_test
verificaciones/protocolo_test
cd backend
.venv/bin/python -m unittest discover -s tests -v
```

Respaldo anterior a esta etapa: `backups/antes_conectividad_20260918/proyecto.tar.gz`, SHA-256 `67c08d75d0dde15113ed0065cf82c0676315b7dbb25dc8ae4e3b9cc745b9feb0`. Incluye fuentes, backend y la base previa, excluyendo entornos virtuales y artefactos regenerables.
