# Seguridad: claves, sesiones y validaciones

Este documento reúne quién puede hacer qué en AlertAR, con qué credencial, dónde se guarda cada una y qué controla el sistema en cada etapa. El código está en `backend/panel.py` (función `proteger()` y rutas de sesión) y `backend/app.py` (configuración y validación).

## Credenciales

| Credencial | Quién la tiene | Dónde se guarda | Qué permite |
|---|---|---|---|
| **Clave administrativa** (`ALERTAR_API_KEY`, mínimo 24 caracteres) | El administrador | Solo en el entorno privado del servidor (`alertar.env`, permisos 600) | Todo: leer, gestionar pasos y enviar eventos. También es la **contraseña del panel** |
| **Sesión del panel** | Quien inició sesión con la contraseña | Cookie firmada en el navegador | Leer todo y, con token CSRF, gestionar pasos. No envía eventos |
| **Clave de dispositivo** (una por paso, 32 caracteres aleatorios) | El ESP32 de ese paso | En el servidor, solo su hash; en el ESP32, en `conectividad_secrets.h` (ignorado por Git) | Únicamente enviar eventos y reservar secuencias **de su paso** |
| **Clave inicial de `tunel-01`** (`ALERTAR_DEVICE_KEY`, opcional) | El primer ESP32 | Entorno privado del servidor | Solo define la clave de `tunel-01` cuando la base se crea por primera vez; después es una clave de dispositivo más |

Ninguna clave está en el repositorio. Cada clave se envía en el encabezado `X-API-Key` y viaja siempre por HTTPS.

## Claves de dispositivo

- Se generan en el servidor (`secrets.token_urlsafe`) al crear un paso o al regenerar su clave, y se muestran **una sola vez**.
- En la base solo queda `sha256:<hash>`. Si alguien copia la base, no obtiene claves utilizables. Como son aleatorias y largas, no hace falta sal.
- Al recibir un pedido, el servidor calcula el hash de la clave recibida y busca el paso que la tiene. Con ella solo se aceptan `POST /api/eventos`, `POST /api/eventos/lote` y la reserva, y únicamente para ese paso y ese dispositivo: otro paso → 403.
- Regenerar la clave invalida la anterior de inmediato.
- Una clave solo vale si su hash está guardado en un paso. `ALERTAR_DEVICE_KEY` se usa únicamente para crear `tunel-01` la primera vez; regenerar la clave de ese paso también la revoca. Una vez creado el paso, conviene quitar la variable del entorno para que no reaparezca si alguna vez se recrea la base.

## Panel: sesión, cookie y CSRF

1. `GET /login` muestra el formulario con un token CSRF guardado en la sesión.
2. `POST /login` compara la contraseña con la clave administrativa en tiempo constante (`hmac.compare_digest`). Si es correcta, limpia la sesión, la marca como iniciada y redirige al panel. Si no, responde 401. Si el token del formulario no coincide, responde 400.
3. La cookie de sesión está **firmada** con una clave derivada de la clave administrativa (cambiar esa clave cierra todas las sesiones), y es `Secure` (solo HTTPS), `HttpOnly` (el JavaScript no la lee) y `SameSite=Strict` (otro sitio no puede usarla). Dura **8 horas**.
4. Toda acción que modifica (crear, editar, regenerar clave, borrar) exige el encabezado `X-CSRF-Token` con el token de la sesión: una página ajena no puede hacer que el navegador ejecute esas acciones. Sin token → 403.
5. `POST /salir` (también con token) cierra la sesión.

Los intentos de adivinar la contraseña están limitados por la cubeta de login: 5 intentos seguidos y después 1 cada 10 s, para todo el servidor.

## Orden de los controles en cada pedido

1. **Concurrencia:** si ya se atienden `ALERTAR_CONCURRENCIA` pedidos, 429.
2. **Tamaño:** cuerpo de más de 16 KiB, 413.
3. **Autenticación** (solo `/api/*` con `ALERTAR_REQUIRE_AUTH=1`): clave administrativa, clave de dispositivo (solo ingesta), sesión (lectura; escritura con CSRF). Si no corresponde, 401 o 403.
4. **Límite de ritmo:** una ficha de la cubeta del tipo de pedido; si no hay, 429 con `Retry-After: 5` ([api.md](api.md#límites-de-ritmo)). Un pedido rechazado por autenticación no consume fichas.
5. **Validación del contenido** en la ruta ([api.md](api.md#contrato-del-evento-v1)).

`/health` y los archivos estáticos no requieren autenticación ni consumen fichas.

## Encabezados de seguridad

Todas las respuestas llevan:

| Encabezado | Valor | Para qué |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` | El navegador solo ejecuta scripts y estilos del propio servidor; nada embebido ni de terceros |
| `X-Frame-Options` | `DENY` | La página no se puede incrustar en otra (clickjacking) |
| `X-Content-Type-Options` | `nosniff` | El navegador no reinterpreta tipos de archivo |
| `Referrer-Policy` | `same-origin` | No se filtra la URL a otros sitios |
| `Cache-Control` | `no-store` (salvo estáticos) | Los datos no quedan en cachés intermedias |

El panel arma todo el contenido con nodos del DOM y nunca con `innerHTML` (una prueba lo verifica), así que un diagnóstico enviado por un dispositivo no puede inyectar código.

## Validaciones por etapa

| Etapa | Qué se verifica |
|---|---|
| ESP32 | Lecturas dentro de rango (2–410 cm), histéresis y confirmación del agua, persistencia antes de alertar ([firmware.md](firmware.md)) |
| Transporte | Certificado del servidor contra la raíz ISRG Root X2; sin hora válida no se envía; ACK con el mismo `evento_id` antes de retirar un evento ([conectividad.md](conectividad.md)) |
| Ingreso | Tamaño, clave, ritmo, contrato exacto de 16 campos, tipos y rangos, hora no más de 60 s en el futuro, paso y dispositivo registrados y propios de la clave |
| Guardado | Identidad y secuencia únicas por dispositivo; duplicado idéntico → 200 sin reinsertar; conflicto → 409; transacción con `synchronous=FULL` antes del ACK |
| Lectura | Un estado sin vigencia (más de 60 s) nunca se presenta como habilitación ([panel.md](panel.md#estado-y-vigencia)) |
| Gestión | Nombre 1–60 caracteres, IDs `a-z 0-9 _ -` sin repetirse, coordenadas en rango, CSRF desde el panel |

## Secretos y repositorio

- `.gitignore` excluye `conectividad_secrets.h`, archivos `.env`, claves (`.pem`, `.key`, `.p12`), bases SQLite, respaldos, binarios compilados (`.bin`, `.elf`: pueden contener la clave del firmware) y notas operativas locales.
- `scripts/verificar_secretos.sh` revisa los archivos versionados: nombres de archivo sensibles y patrones de claves conocidas (bloques PEM, tokens de GitHub, AWS, Google, OpenAI, Slack) o asignaciones de claves con valor. GitHub Actions lo ejecuta en cada push y pull request.
- Si una clave llega a un commit hay que regenerarla: borrarla después no la quita del historial.

## Arranque

- Con `ALERTAR_REQUIRE_AUTH=1` y una clave administrativa de menos de 24 caracteres, el servicio no arranca.
- Con `ALERTAR_REQUIRE_AUTH=0` (modo de desarrollo) **no hay autenticación**: solo debe usarse en `127.0.0.1`.
- Los endpoints `/api/simulador/*` insertan eventos sin validar y solo existen con `ALERTAR_ENABLE_SIMULATOR=1`; nunca en el servidor publicado.

## Puntos débiles conocidos

- Los límites de ritmo son globales, no por usuario: alguien con muchos pedidos puede demorar a los demás (también el login), aunque no puede leer ni escribir sin credenciales.
- El hash de las claves de dispositivo es SHA-256 sin sal: adecuado para claves aleatorias de 32 caracteres, no para contraseñas elegidas por personas.
- No hay registro de auditoría de quién creó, editó o borró un paso.
