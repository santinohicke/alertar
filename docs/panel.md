# Panel web de AlertAR

El panel está en `backend/templates/panel.html`, `backend/static/panel.css` y `backend/static/panel.js`. No usa bibliotecas ni servicios externos: todo se sirve desde el mismo servidor, y la política de seguridad de contenido (CSP) solo permite recursos propios. El JavaScript construye el contenido con nodos del DOM, nunca con `innerHTML`, así que un texto recibido de un dispositivo no puede inyectar código.

## Estructura

- **Barra lateral:** todos los pasos a nivel, cada uno con su luz de estado. El paso seleccionado se distingue por el fondo más claro. Abajo, el botón para agregar un paso y el cierre de sesión.
- **Encabezado:** nombre del paso, ubicación, dispositivo y enlace al mapa externo si tiene coordenadas. El indicador *En vivo* muestra la hora de la última consulta correcta.
- **Pestañas:** Monitoreo, Historial, Estadísticas y Mapa.

En pantallas angostas la barra lateral pasa a ser una fila de pasos desplazable arriba del contenido.

## Estado y vigencia

El color se reserva para el estado del paso; el resto de la interfaz es neutra.

| Severidad | Códigos | Señal |
|---|---|---|
| Verde | `OK-001`, `INF-001` | Paso habilitado |
| Amarillo | `ERR-002`, `ERR-003`, `ERR-004`, `ERR-006`, `ERR-007` | Precaución |
| Rojo | `ERR-001`, `ERR-005` | Paso cerrado |
| Gris | cualquiera sin vigencia confirmada | Sin confirmar |

Una medición está **vigente** cuando la API informa recepción reciente y medición reciente (umbral de 60 s, `STALE_SECONDS`). Si deja de llegar información, el panel la pasa a *Sin confirmar* a los 30 s de la última medición aunque todavía no haya vuelto a consultar. Sin vigencia nada se muestra en verde: las lecturas quedan en gris con la leyenda *Último valor conocido*, porque un dato antiguo no confirma que el paso esté habilitado. El último código sigue visible como dato histórico.

## Monitoreo

- **Banda de estado:** señal con su lámpara, diagnóstico del ESP32, vigencia, código, hora de medición y secuencia.
- **Lecturas:** altura de obstrucción de cada carril con una escala de 0 a 250 cm (marcas en 5 cm, libre, y 100 cm, alta) y el agua en tres pasos: seco, confirmando y crítica.
- **Eventos recientes:** los últimos 20 por secuencia.
- **Dispositivo:** ID del paso, ID del dispositivo, coordenadas y URL de envío. En la rama `demo` también la clave del dispositivo, oculta hasta pulsar *Mostrar* y con botón para copiarla. En la rama `demo` también la clave del dispositivo, oculta hasta pulsar *Mostrar* y con botón para copiarla; los pasos creados antes de guardar claves muestran "No disponible". Al pie, *Borrar dispositivo* elimina el paso, su clave, sus lecturas y sus reservas de secuencia después de confirmar en una ventana que indica cuántas lecturas se pierden. `tunel-01` es el paso base que la API vuelve a crear al iniciar, por eso no se puede borrar.

La pestaña consulta `/api/panel/<paso>` cada 5 s y se pausa mientras la pestaña del navegador está oculta.

### Animaciones

- **Medición nueva:** las filas nuevas entran resaltadas y un barrido corto recorre el borde de la banda de estado.
- **Escalamiento:** al pasar a precaución o a cierre, la banda muestra un anillo de atención (dos pulsos en amarillo, tres en rojo) y el título de la pestaña del navegador cambia a *Precaución* o *Paso cerrado*. Cambiar de paso no cuenta como escalamiento.
- **Cierre:** mientras el paso está cerrado, la lámpara titila lento, como la señal física.

Todas las animaciones respetan `prefers-reduced-motion`.

## Luces de estado de todos los pasos

Cada 10 s el panel consulta `/api/tuneles`, que en un solo pedido devuelve el último código y la última recepción de cada paso. Un paso se colorea si recibió algo en los últimos 60 s; si no, queda gris. El paso abierto en Monitoreo usa su consulta de 5 s, que es más precisa. Ese mismo dato alimenta el mapa.

## Historial

Registros paginados (10 a 200 por página, de la secuencia más alta a la más baja) con medición, recepción, código, diagnóstico, agua, carriles y secuencia; cada fila abre su JSON completo.

**Exportación** en CSV (con BOM para que Excel respete los acentos) o JSON:

- *Página actual*: la arma el navegador con los registros que ya tiene cargados.
- *Últimas 24 horas*, *7 días*, *30 días*, *Todo el historial* o *Rango de fechas* (desde y hasta, en hora local): el panel abre `GET /api/pasos/<paso>/exportar` y el navegador descarga el archivo con su propio indicador de progreso. El servidor lo genera fila por fila y lo envía por partes, así que no importa cuántos registros haya: 84.000 registros (19 MB de CSV) tardan unos 3 s y el servicio no carga el archivo entero en memoria. Las fechas se comparan con la fecha de medición (o la de recepción si el evento no tiene hora).

## Estadísticas

El servidor calcula el resumen con `GET /api/pasos/<paso>/estadisticas?rango=…` (`backend/estadisticas.py`) y el panel solo lo dibuja. Para un paso con 14 días de datos la respuesta pesa unos 25–30 KB; la versión anterior descargaba todo el historial al navegador.

- **Tiempo por estado:** cada evento cuenta hasta 15 s o hasta el evento siguiente, lo que sea menor. Pasado ese lapso sin datos no se suma tiempo a ningún estado. *Tiempo en OK-001* cuenta solo ese código, aunque `INF-001` también se pinte de verde.
- **Indicadores:** tiempo en OK-001, agua activa, tiempo monitoreado, registros en el rango y en la base, reinicios del ESP32 (arranques distintos) y última recepción. Los números cuentan hasta el valor nuevo al cambiar de rango.
- **Estado y eventos recibidos:** arriba, una franja de 720 tramos con el estado en el tiempo. Cada tramo toma la severidad más grave que ocupe al menos el 10 % de su tiempo cubierto, así un cierre breve no desaparece; los tramos sin datos quedan vacíos. Debajo, barras con los eventos recibidos por bloque (5 min para 1 h, 30 min para 6 h, 1 h para 24 h, 6 h para 7 días; en *Todo* se elige según el período). Pasar el mouse muestra el detalle del bloque; un click lo deja fijo hasta otro click. Sin selección, el detalle resume todo el rango.
- **Tiempo por código:** barra apilada por severidad y lista de códigos con su tiempo y porcentaje.
- **Sensores y comunicación:** validez, promedio y máximo por carril; demora promedio y máxima entre medición y recepción; saltos de secuencia dentro de un mismo arranque; eventos sin hora medida.
- **Obstrucción por carril:** serie reducida a 600 puntos que conserva el máximo de cada bloque para no perder picos breves, con referencias en 5 y 100 cm. La línea se corta donde faltan datos. Un click fija el cursor en un punto.

El servidor guarda cada resumen 10 s para que varios paneles compartan el cálculo, y el panel guarda cada paso y rango 60 s: cambiar de paso o de rango y volver es instantáneo. *Recalcular* fuerza un pedido nuevo. Los gráficos se dibujan al ancho real del contenedor para que el texto no se achique.

## Mapa

La pestaña Mapa dibuja un mapa esquemático de la Ciudad de Buenos Aires en SVG, sin servicios de mapas externos: el contorno, el río, el Riachuelo, las vías del ferrocarril, avenidas principales y secundarias, parques y algunos lugares de referencia. Los trazados son aproximados, alcanzan para ubicar los pasos y no son cartografía exacta.

- Se mueve arrastrando y se acerca con la rueda o con los botones. Las etiquetas aparecen según el acercamiento: barrios en la vista general, lugares y avenidas principales al acercar, todas las avenidas de cerca.
- Cada paso con coordenadas es un marcador con el color de su estado (rojo con pulso si está cerrado). Un click en el marcador, o en la lista *Estado actual*, abre su Monitoreo. Los pasos sin coordenadas figuran en la lista como *Sin ubicación*.
- Al agregar un paso, la ubicación se marca tocando el mismo mapa; las coordenadas exactas se pueden escribir en *Opciones avanzadas* y el marcador se actualiza.

## Límites y concurrencia

El servidor limita el ritmo de pedidos por tipo (ingesta, lectura, administración y login) con cubetas globales por proceso y atiende hasta 16 pedidos a la vez. Los valores, sus variables de entorno y los de la Raspberry Pi están en [api.md](api.md#límites-de-ritmo). Con los valores por defecto, 20 paneles abiertos y 10 ESP32 enviando su cola al mismo tiempo no reciben rechazos.
