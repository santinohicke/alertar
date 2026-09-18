# Implementación de AlertAR

## Actualización: pasos 3, 4 y 5

Wi-Fi/HTTP, registro LittleFS y reenvío con confirmación implementados en AlertAR-2. Comunicación real Wokwi → Flask → SQLite comprobada (20 eventos al cierre). Las pruebas integrales de cortes y reinicio se retoman en la próxima sesión. Ver `CONECTIVIDAD.md` para estado completo, instrucciones, límites y punto exacto de reanudación. Las secciones siguientes conservan el registro de los pasos 1 y 2.

## Avance al 18 de septiembre de 2026

- Paso 1: respaldo y preparación realizados; compilación del firmware correcta. La verificación completa de la lógica conserva una incidencia preexistente detallada abajo.
- Paso 2: backend Flask + SQLite implementado y probado.
- Pendientes: paso 3 (Wi-Fi/HTTP del ESP32), paso 4 (LittleFS/log), paso 5 (recuperación), paso 6 (panel) y paso 7 (pruebas integrales).

## Archivos

- `backups/antes_backend_20260918/proyecto_original.tar.gz`: respaldo de fuentes, diagramas, pruebas y configuración originales; su README incluye checksum y alcance.
- `backend/app.py`: API y creación no destructiva de tablas.
- `backend/instance/alertar.sqlite3`: base de uso normal, inicializada sin eventos de demostración.
- `backend/README.md`: arranque, contrato de eventos, respuestas y consultas manuales.
- `backend/examples/evento.json`: evento de ejemplo para POST manual.
- `backend/tests/test_api.py`: 11 pruebas automatizadas.
- `backend/requirements.txt`: dependencia directa; `requirements-lock.txt`: versiones exactas verificadas del entorno.
- `backend/.venv`: entorno Python local al proyecto.
- `verificaciones/limite_sensor.cpp`: diagnóstico independiente de la discrepancia preexistente.

No se modificaron fuentes, diagramas ni configuración del ESP32. La compilación regeneró artefactos de PlatformIO en `AlertAR-2/.pio`.

## Verificación

1. PlatformIO: `platformio run -d AlertAR-2`, SUCCESS. RAM 22124/327680 bytes (6,8%); flash 296873/1310720 bytes (22,6%).
2. Backend: 11 pruebas aprobadas, incluyendo reintentos concurrentes, persistencia, orden de eventos, fechas, validación y errores de almacenamiento.
3. Servidor Flask real iniciado en 127.0.0.1:5001. GET `/health` respondió HTTP 200 con `{"base_datos":"ok","estado":"ok"}`.
4. Base de uso normal inicializada con cero eventos. Las pruebas usaron carpetas temporales dentro de backend.
5. Suite C++ preexistente: falla una aserción. `tests/logica_test.cpp` exige ERR-003 para 400,1 cm, pero `AlertAR-2/src/logica.h` acepta hasta 410 cm. El diagnóstico confirmó OK-001 para 400 y 400,1 y 410 cm, y ERR-003 para 410,1 cm. No se cambió este comportamiento ni se adaptó silenciosamente la prueba. La suite se detiene en esa falla, por lo que no se afirma que los casos posteriores hayan pasado.

## Decisiones para los siguientes pasos

La secuencia debe persistir entre reinicios por dispositivo. El servidor usa esa secuencia para evitar que la recuperación de datos atrasados reemplace un estado más reciente. El mapa inicial es tunel-01 → esp32-01; el firmware todavía no emite este contrato. Los reintentos conservarán identidad y contenido. La hora desconocida se informa como null, sin inventar una fecha de medición a partir de la recepción.

La API es local y no tiene autenticación ni panel. No se conecta aún a Wokwi; esa verificación corresponde al paso 3. Las pruebas de reinicio del backend no prueban persistencia de flash del ESP32 ni reinicio del simulador.
