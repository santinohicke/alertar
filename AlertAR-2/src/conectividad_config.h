#pragma once
#if __has_include("conectividad_secrets.h")
#include "conectividad_secrets.h"
#endif
#ifndef ALERTAR_CONECTIVIDAD_HABILITADA
#define ALERTAR_CONECTIVIDAD_HABILITADA false
#endif
#ifndef ALERTAR_API_URL
#define ALERTAR_API_URL ""
#endif
#ifndef ALERTAR_RESERVA_API_URL
#define ALERTAR_RESERVA_API_URL ""
#endif
#ifndef ALERTAR_DEVICE_KEY
#define ALERTAR_DEVICE_KEY ""
#endif
// Intervalo entre mediciones enviadas al servidor cuando no hay cambios de estado.
// Un cambio de estado se envía siempre en el momento.
// SOLO PARA LA DEMO: 5 s para la presentación; en main son 15 s.
#ifndef ALERTAR_MUESTRA_MS
#define ALERTAR_MUESTRA_MS 5000
#endif

namespace conexion_config {
constexpr bool HABILITADA = ALERTAR_CONECTIVIDAD_HABILITADA;
constexpr char SSID[] = "Wokwi-GUEST";
constexpr char PASSWORD[] = "";
constexpr char API[] = ALERTAR_API_URL;
constexpr char API_LOTE[] = ALERTAR_API_URL "/lote"; // Varios eventos por pedido.
constexpr char RESERVA_API[] = ALERTAR_RESERVA_API_URL;
constexpr char API_KEY[] = ALERTAR_DEVICE_KEY; // Solo ingesta; nunca la clave principal.
constexpr char DISPOSITIVO[] = "esp32-01";
constexpr char PASO[] = "tunel-01";
constexpr unsigned MUESTRA_MS = ALERTAR_MUESTRA_MS;
constexpr unsigned MAX_PENDIENTES = 128;
constexpr unsigned MAX_ENVIADOS = 16;
constexpr unsigned COLA_RAM = 64;
// Un POST tarda ~4 s en Wokwi: con 5 s un pedido lento cortaba la conexión y forzaba otro
// handshake de casi un minuto.
constexpr unsigned TIMEOUT_HTTP_MS = 15000;
constexpr unsigned TIMEOUT_TLS_S = 120; // Cálculo criptográfico lento en el simulador; tarea separada.
constexpr unsigned WATCHDOG_S = TIMEOUT_TLS_S + 60; // Debe superar el handshake más largo.
// Wokwi puede avanzar a una velocidad distinta del reloj real. El valor por
// defecto del SDK (3 h) deja que ambos relojes se separen más que la vigencia.
constexpr unsigned SINCRONIZACION_RELOJ_MS = 5 * 60 * 1000;
constexpr unsigned RESERVA_SECUENCIAS = 1024;
// Pausa mínima entre pedidos: protege al servidor sin demorar el envío de un cambio.
constexpr unsigned ENTRE_ENVIOS_MS = 1000;
constexpr unsigned RECUPERACION_MS = 1000; // Con pendientes: hasta 1 pedido/s por dispositivo.
// Eventos por pedido al vaciar pendientes (el servidor acepta hasta 10). El más nuevo va
// primero para que el panel muestre el estado actual; el resto completa el historial.
constexpr unsigned LOTE_MAX = 9;
constexpr unsigned DIAGNOSTICO_MS = 10000;
}
