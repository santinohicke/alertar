# Lógica de validación cruzada — versión corregida

Se conservan los nueve códigos existentes, sin agregar filas. Se aplica la primera fila que coincida, en el orden mostrado.

| Carriles (ultrasónicos) | Altura de obstrucción | Duración | Sensor de agua | Diagnóstico | Código único | Cartel LCD / semáforo |
| --- | --- | --- | --- | --- | --- | --- |
| Cualquier estado, incluso lectura inválida | Cualquiera | Agua confirmada durante 20 s | Confirmado o en espera de secado | Agua a cota crítica; cierre preventivo por inundación | ERR-001 | PASO CERRADO / Agua critica — rojo |
| Uno o ambos sin lectura válida | Inválida | Cualquiera | No confirmado | Falla de medición ultrasónica | ERR-003 | PRECAUCION / Falla de sensor — amarillo |
| Ambos obstruidos | Cualquier combinación de alturas | Ambos persistentes (≥60 s de ocupación válida) | No confirmado | Bloqueo persistente en ambos carriles | ERR-005 | PASO CERRADO / Ambos bloqueados — rojo |
| Cualquier estado válido que no requiera cierre | Cualquiera | Activación aún no confirmada (<20 s) | Pendiente | Verificando presencia de agua | ERR-002 | PRECAUCION / Verificando agua — amarillo |
| Ambos obstruidos; excluye ERR-005 e INF-001 | Cualquier combinación, incluidas bajas, medias y mixtas | Al menos uno persistente (≥60 s); aún no ambos | Inactivo y no confirmado | Obstrucción en ambos carriles, sin inferir material | ERR-004 | PRECAUCION / Obstruccion — amarillo |
| Solo uno obstruido | Alta (>100 cm) | Alta persistente (≥60 s en categoría alta) | Inactivo y no confirmado | Obstrucción alta persistente en un carril | ERR-006 | PRECAUCION / Carril bloqueado — amarillo |
| Solo uno obstruido; excluye ERR-006 e INF-001 | Baja/media (>5 y ≤100 cm), o alta que no cumple las otras reglas | Ocupación persistente (≥60 s) | Inactivo y no confirmado | Obstrucción en un carril, sin inferir material | ERR-007 | PRECAUCION / Obstruccion — amarillo |
| Uno o ambos obstruidos | Cualquiera, incluidas bajas, medias y mixtas | Cada carril ocupado lleva <60 s de ocupación válida | Inactivo y no confirmado | Ocupación transitoria pendiente de confirmación; no prueba movimiento | INF-001 | Paso habilitado / Transitorio — verde |
| Ambos libres y válidos | ≤5 cm | Libre; 3 s de liberación si había ocupación persistente | Inactivo y no confirmado | Situación normal | OK-001 | Paso habilitado — verde |

## Condiciones de implementación

- Prioridad: agua confirmada, falla ultrasónica, bloqueo persistente de ambos carriles, agua pendiente y luego las restantes filas. ERR-002 también es la salida defensiva para un estado no clasificado: PRECAUCION / Verificar paso, amarillo.
- Se elimina el corte de 50 cm: bajas y medias se agrupan. Exactamente 5 cm es libre y exactamente 100 cm es obstrucción baja/media. La clasificación considera el estado retenido mientras se confirman 3 s de liberación.
- Agua: ADC >2000 activa la lectura; ADC ≤1800 la desactiva. En el intervalo se conserva la lectura anterior (histéresis). Se requieren 20 s continuos para confirmar agua y 20 s continuos de lectura inactiva para retirar el cierre. Desde la primera lectura activa se muestra precaución, salvo que corresponda un cierre. Los umbrales requieren calibración con el sensor real.
- Ultrasónicos: distancia válida de 2 a 400 cm y montaje a 400 cm en la simulación. Altura de obstrucción = 400 − distancia. Distancia de 400 cm representa paso libre; distancia de 100 cm representa una obstrucción de 300 cm. Fuera del rango o sin eco se informa lectura inválida. El montaje real debe calibrarse; si el techo supera 4 m, se necesita otro sensor con mayor alcance. Nunca se interpreta una falla como carril libre.
- Todas las alertas de obstrucción requieren al menos 60 s de ocupación válida en algún carril; antes se usa INF-001 (verde), salvo agua o falla de sensor. Una lectura libre reinicia una ocupación todavía transitoria, para no sumar vehículos sucesivos. Una ocupación persistente ya confirmada exige 3 s de lecturas libres para retirarse. Durante lecturas inválidas se conserva el estado y se pausa el tiempo acumulado. Solo se suma tiempo entre observaciones válidas consecutivas de obstrucción; no se suma durante liberación. El contador de categoría alta reinicia al observar una obstrucción baja/media. Los contadores saturan a 60 s y soportan el desbordamiento de millis().
- El muestreo local del prototipo es aproximadamente cada 260–320 ms, con disparos ultrasónicos separados por 60 ms. El agua se consulta por ADC en cada ciclo; no se usa interrupción ni espera de 1–10 minutos. La telemetría se emite como una línea JSON por ciclo, únicamente por puerto serie.
- Los dos sensores observan carriles diferentes: no son redundancia completa del mismo punto. Una medición de altura tampoco prueba material ni movimiento; los diagnósticos se expresan como obstrucciones observadas.
- ERR-003 cubre fallas ultrasónicas detectables. Un sensor de agua desconectado o trabado, una pérdida total de energía y una falla de red requieren supervisión adicional; el código no afirma detectarlos. Una cota de agua confirmada conserva el cierre aunque falle un ultrasónico.

## Archivos

La misma implementación está en `AlertAR-2/src/main.cpp` + `logica.h` (PlatformIO) y `AlertAR/sketch.ino` + `logica.h` (Arduino/Wokwi). Los originales se conservan en `backups/antes_correccion_logica`.
