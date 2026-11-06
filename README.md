# AlertAR

AlertAR es un prototipo de ciudad inteligente para supervisar **pasos bajo nivel** (túneles por debajo de las vías del tren). En cada paso, un ESP32 mide si hay obstrucciones en los dos carriles y si se acumula agua, decide localmente si el paso está habilitado y lo indica con un semáforo y una pantalla. Además envía cada medición a un servidor, donde un panel web muestra en vivo el estado de todos los pasos, su historial, estadísticas y un mapa de la ciudad.

**Panel publicado:** [homebase.tail5a3b96.ts.net:8443](https://homebase.tail5a3b96.ts.net:8443/) (requiere contraseña) · **Repositorio:** [Agusttin-0/AlertAR](https://github.com/Agusttin-0/AlertAR)

```text
 Paso a nivel                      Servidor                         Navegador
┌───────────────────┐  HTTPS   ┌─────────────────────────┐ HTTPS ┌──────────────┐
│ sensores → ESP32  │ ───────► │ API Flask + SQLite      │ ────► │ panel web    │
│ semáforo y LCD    │  eventos │ validación y resúmenes  │       │ en vivo      │
└───────────────────┘          └─────────────────────────┘       └──────────────┘
```

El ESP32 decide la seguridad por su cuenta: si se corta Internet, el semáforo sigue funcionando y las mediciones se guardan para enviarlas después.

## Sistemas

| Sistema | Qué hace | Dónde está | Documento |
|---|---|---|---|
| **Recorrido de los datos** | Cómo viaja una medición desde el sensor hasta el panel, qué identidades y horas lleva y qué pasa si algo falla | — | [docs/arquitectura.md](docs/arquitectura.md) |
| **Firmware del ESP32** | Mide los carriles (ultrasonido) y el agua, aplica histéresis y tiempos de confirmación, decide uno de nueve estados y maneja LEDs y LCD | `AlertAR-2/src/` | [docs/firmware.md](docs/firmware.md) · [tabla de estados](docs/tabla_logica.md) |
| **Conectividad** | Convierte cada estado en un evento, lo guarda en una cola que sobrevive a reinicios y lo envía por HTTPS con reintentos | `AlertAR-2/src/conectividad.*` | [docs/conectividad.md](docs/conectividad.md) |
| **API y base de datos** | Recibe y valida eventos, evita duplicados, guarda en SQLite y calcula estado, estadísticas y exportaciones | `backend/app.py`, `panel.py`, `estadisticas.py` | [docs/api.md](docs/api.md) |
| **Seguridad** | Contraseña del panel, claves por dispositivo, sesiones, CSRF, límites de ritmo y control de secretos | `backend/panel.py`, `scripts/` | [docs/seguridad.md](docs/seguridad.md) |
| **Panel web** | Monitoreo en vivo, historial, estadísticas y mapa de CABA; alta y baja de pasos | `backend/templates/`, `backend/static/` | [docs/panel.md](docs/panel.md) |
| **Despliegue** | Servidor con gunicorn y Tailscale Funnel; cómo instalarlo, actualizarlo o llevarlo a otro servidor | `deploy/servidor/`, `deploy/raspi/` | [docs/despliegue.md](docs/despliegue.md) · [Raspberry Pi](docs/raspberry.md) |
| **Estado del proyecto** | Qué está implementado, qué se comprobó y qué falta validar | — | [docs/estado.md](docs/estado.md) |

## Requisitos y credenciales en un vistazo

- **Para simular un paso:** Visual Studio Code con PlatformIO y Wokwi, y la **clave de dispositivo** del paso (se obtiene al crearlo en el panel). Se coloca en `AlertAR-2/include/conectividad_secrets.h`, que no se sube a Git.
- **Para usar el panel:** la **contraseña del panel** (la clave administrativa del servidor). La sesión dura 8 horas.
- **Para desplegar el servidor:** Linux con systemd, Python 3.11 o posterior, Tailscale y las variables privadas del servicio. Ver [docs/despliegue.md](docs/despliegue.md).
- Cada clave de dispositivo solo puede enviar datos de su propio paso. Ninguna clave está en el repositorio. Detalle en [docs/seguridad.md](docs/seguridad.md).

## Simular un paso con Wokwi

1. Abrir la carpeta `AlertAR-2` en Visual Studio Code (extensiones PlatformIO IDE y Wokwi Simulator).
2. Copiar `include/conectividad_secrets.example.h` como `include/conectividad_secrets.h`.
3. Para probar solo sensores, LEDs y LCD, dejar `ALERTAR_CONECTIVIDAD_HABILITADA` en `false`. Para enviar al servidor, ponerlo en `true`, completar la clave del paso y su `dispositivo_id` en la URL de reserva, y ajustar `DISPOSITIVO` y `PASO` en `src/conectividad_config.h`.
4. **PlatformIO: Build** y luego **Wokwi: Start Simulator**. Wokwi no recompila: después de cada cambio hay que volver a compilar.

En el simulador se mueven los objetos frente a los sensores y el control del agua; el monitor serie muestra el estado y el diagnóstico de la conexión.

## Estructura del repositorio

```text
AlertAR-2/          firmware del ESP32 y circuito de Wokwi
tests/              pruebas C++ de la lógica, la cola y el protocolo
backend/            API, panel web, estadísticas, simulador y pruebas
deploy/servidor/    plantilla del servicio para un servidor Linux
deploy/raspi/       instalación anterior en una Raspberry Pi
deploy/demo/        solo demo: historial artificial y prueba de carga
scripts/            control de secretos antes de cada push
docs/               documentación de cada sistema
```

## Ramas

| Rama | Contenido |
|---|---|
| `main` | Proyecto real |
| `demo` | `main` más herramientas para presentaciones: clave visible de cada dispositivo en el panel, historial artificial y prueba de carga. No usar en un despliegue real |

Los cambios entran a `main` por pull request y después se integran en `demo`, nunca al revés.

### Esta rama: `demo`

Además de todo lo de `main`:

- **Clave visible de cada dispositivo.** Al crear un paso o regenerar su clave, el servidor guarda también una copia en `tuneles.clave_demo` y el panel la muestra al pie de Monitoreo → Dispositivo, oculta hasta pulsar *Mostrar*, con botón para copiarla. La autenticación sigue usando solo el hash. Se desactiva con `ALERTAR_DEMO_CLAVES=0`; los pasos creados antes muestran "No disponible". Implicancias de seguridad en [docs/seguridad.md](docs/seguridad.md#rama-demo-claves-visibles).
- **Pasos de demo, historial artificial y prueba de carga:** [deploy/demo/README.md](deploy/demo/README.md).

Para volver al proyecto real: desplegar `main` y vaciar `clave_demo`.

## Pruebas y controles

- `tests/`: lógica de estados (2.700 combinaciones), cola y protocolo del firmware, en C++.
- `backend/tests/`: 49 pruebas (47 de `main` más 2 de las claves de la demo) de API, panel, autenticación, estadísticas, exportación, borrado y límites de ritmo. Se ejecutan desde `backend/` con `.venv/bin/python -m unittest discover -s tests`; instalación local en [backend/README.md](backend/README.md).
- `scripts/verificar_secretos.sh` y GitHub Actions impiden subir claves, bases de datos o binarios.
