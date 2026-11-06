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

namespace conexion_config {
constexpr bool HABILITADA = ALERTAR_CONECTIVIDAD_HABILITADA;
constexpr char SSID[] = "Wokwi-GUEST";
constexpr char PASSWORD[] = "";
constexpr char API[] = ALERTAR_API_URL;
constexpr char RESERVA_API[] = ALERTAR_RESERVA_API_URL;
constexpr char API_KEY[] = ALERTAR_DEVICE_KEY; // Solo ingesta; nunca la clave principal.
constexpr char DISPOSITIVO[] = "esp32-01";
constexpr char PASO[] = "tunel-01";
constexpr unsigned MUESTRA_MS = 15000;
constexpr unsigned MAX_PENDIENTES = 128;
constexpr unsigned MAX_ENVIADOS = 16;
constexpr unsigned COLA_RAM = 64;
constexpr unsigned TIMEOUT_HTTP_MS = 5000;
constexpr unsigned TIMEOUT_TLS_S = 120; // Cálculo criptográfico lento en el simulador; tarea separada.
// Wokwi puede avanzar a una velocidad distinta del reloj real. El valor por
// defecto del SDK (3 h) deja que ambos relojes se separen más que la vigencia.
constexpr unsigned SINCRONIZACION_RELOJ_MS = 5 * 60 * 1000;
constexpr unsigned RESERVA_SECUENCIAS = 1024;
constexpr unsigned ENTRE_ENVIOS_MS = 3000;
constexpr unsigned RECUPERACION_MS = 1000; // Con backlog: hasta 1 evento/s por dispositivo.
constexpr unsigned DIAGNOSTICO_MS = 10000;
}
