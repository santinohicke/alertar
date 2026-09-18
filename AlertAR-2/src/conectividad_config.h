#pragma once

namespace conexion_config {
constexpr char SSID[] = "Wokwi-GUEST";
constexpr char PASSWORD[] = "";
constexpr char API[] = "http://host.wokwi.internal:5001/api/eventos";
constexpr char DISPOSITIVO[] = "esp32-01";
constexpr char PASO[] = "tunel-01";
constexpr unsigned MUESTRA_MS = 10000;
constexpr unsigned MAX_PENDIENTES = 128;
constexpr unsigned MAX_ENVIADOS = 16;
constexpr unsigned COLA_RAM = 64;
constexpr unsigned TIMEOUT_HTTP_MS = 2000;
constexpr unsigned RESERVA_SECUENCIAS = 1024;
}
