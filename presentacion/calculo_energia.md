# Cálculo del consumo de energía por paso

Total: **8,8 kWh por día**, unos **$110.000 por mes** con la tarifa de Edesur.

## 1. Potencia de cada equipo

| Equipo | Potencia | De dónde sale | Fuente |
|---|---|---|---|
| Cartel LED de mensaje variable, de día | 600 W | El fabricante indica entre 500 y 700 W con un mensaje estándar de día. Se toma el medio. | [Softled, memoria técnica del panel de mensaje variable](https://www.softled.es/app/download/13197772/MEMORIA+TECNICA+GENERAL.pdf) |
| Cartel LED de mensaje variable, de noche | 100 W | El mismo documento dice que de noche, con menos brillo, baja hasta unos 60 W. Se toman 100 W para tener margen. | [Softled, memoria técnica](https://www.softled.es/app/download/13197772/MEMORIA+TECNICA+GENERAL.pdf) |
| Semáforo LED de 300 mm | 15 W | Siempre hay una sola luz encendida (verde, amarilla o roja). Cada luz consume 12 W como máximo; se suman 3 W del controlador. | [FS Compras, semáforo LED 300 mm JD200-3 ("Consumo por sección: ≤12W")](https://fscompras.com/producto/semaforo-led-de-300-mm-3-secciones-rojo-amarillo-y-verde-jd200-3-zgsm-3-ryg/) |
| ESP32, 2 sensores ultrasónicos y pantalla | 1,5 W | El ESP32 consume como máximo 240 mA transmitiendo por Wi-Fi: 0,24 A × 3,3 V = 0,8 W. Cada ultrasónico consume 15 mA a 5 V (0,075 W). Con la pantalla y las pérdidas de la fuente se redondea a 1,5 W. | [Espressif, datasheet del ESP32 (Tabla 5-4)](https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf) y [datasheet del HC-SR04](https://www-users.cs.york.ac.uk/~mjf/roach/Datasheets/HCSR04_Manual.pdf) |

## 2. Energía por día

| Equipo | Cuenta | kWh por día |
|---|---|---|
| Cartel de día | 600 W × 12 h = 7.200 Wh | 7,2 |
| Cartel de noche | 100 W × 12 h = 1.200 Wh | 1,2 |
| Semáforo | 15 W × 24 h = 360 Wh | 0,36 |
| ESP32, sensores y pantalla | 1,5 W × 24 h = 36 Wh | 0,04 |
| **Total** | 7,2 + 1,2 + 0,36 + 0,04 | **8,8** |

El cartel es el 95 % del consumo (8,4 de 8,8 kWh).

## 3. Costo por mes

Tarifa Edesur T1-G1 (pequeñas demandas, uso general): **$266,081 por kWh** y **$20.225 de cargo fijo por mes**.
Fuente: [Edesur, cuadro tarifario (Res. ENReGE 887/26)](https://www.edesur.com.ar/tarifas-cuadro-tarifario/)

| Concepto | Cuenta | Monto |
|---|---|---|
| Energía del mes | 8,8 kWh × 30 días = 264 kWh × $266,081 | $70.245 |
| Cargo fijo | | $20.225 |
| Subtotal sin IVA | | $90.470 |
| IVA 21 % | $90.470 × 0,21 | $18.999 |
| **Total por mes** | | **$109.469 ≈ $110.000** |

## 4. Para comparar

- Un paso **sin cartel ni semáforo** consume solo el ESP32 con los sensores: **0,04 kWh por día**.
- Lo que más consume es el cartel encendido todo el día. Si se prende solo durante las alertas, el consumo baja mucho.
