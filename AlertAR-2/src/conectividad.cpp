#include "conectividad.h"
#include "conectividad_config.h"
#include "registro.h"
#include "protocolo.h"
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <atomic>
#include <esp_partition.h>
#include <esp_timer.h>
#include <time.h>

namespace conectividad {
namespace {
using namespace conexion_config;
using protocolo::Muestra;
QueueHandle_t entrada = nullptr;
SemaphoreHandle_t mutexDisco = nullptr;
std::atomic<bool> listo{false}, wifiPermitido{true};
std::atomic<unsigned> pendientes{0}, descartados{0}, confirmados{0}, errores{0};
std::atomic<int> httpEstado{0};
// 0 iniciando, 1 listo, 2 lleno, 3 error almacenamiento, 4 error tareas.
std::atomic<int> almacen{0};
Preferences preferencias;
protocolo::Secuencias secuencias(0);
char arranque[33];

class Flash : public registro::Disco {
 public:
  std::vector<std::string> listar(const std::string &dir) override {
    std::vector<std::string> result;
    File root = LittleFS.open(dir.c_str());
    if (!root || !root.isDirectory()) return result;
    for (File f = root.openNextFile(); f; f = root.openNextFile()) {
      if (!f.isDirectory()) {
        std::string name(f.name());
        result.push_back(name.substr(name.find_last_of('/') + 1));
      }
      f.close();
    }
    return result;
  }
  bool leer(const std::string &path, std::string &text) override {
    File f = LittleFS.open(path.c_str(), "r");
    if (!f || f.size() > 2048) return false;
    const auto size = f.size();
    text.resize(size);
    return f.readBytes(&text[0], size) == size;
  }
  bool escribir(const std::string &path, const std::string &text) override {
    File f = LittleFS.open(path.c_str(), "w");
    if (!f) return false;
    const bool ok = f.write(reinterpret_cast<const uint8_t *>(text.data()), text.size()) == text.size();
    f.flush();
    f.close();
    return ok;
  }
  bool mover(const std::string &a, const std::string &b) override {
    return LittleFS.rename(a.c_str(), b.c_str());
  }
  bool borrar(const std::string &path) override { return LittleFS.remove(path.c_str()); }
} flash;
registro::Cola cola(flash, MAX_PENDIENTES, MAX_ENVIADOS);

bool particionVirgen() {
  const auto *part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
      ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "spiffs");
  if (!part) return false;
  uint8_t bytes[256];
  for (size_t pos = 0; pos < part->size; pos += sizeof(bytes)) {
    if (esp_partition_read(part, pos, bytes, sizeof(bytes)) != ESP_OK) return false;
    for (auto byte : bytes) if (byte != 0xff) return false;
    if ((pos % 4096) == 0) vTaskDelay(1);
  }
  return true;
}

bool montar() {
  if (!LittleFS.begin(false)) {
    // Nunca autoformatear un sistema existente/corrupto con eventos pendientes.
    if (!particionVirgen() || !LittleFS.format() || !LittleFS.begin(false)) return false;
  }
  if ((!LittleFS.exists("/pendientes") && !LittleFS.mkdir("/pendientes")) ||
      (!LittleFS.exists("/enviados") && !LittleFS.mkdir("/enviados"))) return false;
  if (!preferencias.begin("alertar", false)) return false;
  // Si se perdió NVS pero quedaron logs, no reutilizar sus identidades.
  if (!preferencias.isKey("limite") &&
      (!flash.listar("/pendientes").empty() || !flash.listar("/enviados").empty())) return false;
  secuencias = protocolo::Secuencias(preferencias.getULong64("limite", 0));
  snprintf(arranque, sizeof(arranque), "%08lx%08lx%08lx%08lx",
      (unsigned long)esp_random(), (unsigned long)esp_random(),
      (unsigned long)esp_random(), (unsigned long)esp_random());
  return true;
}

bool secuencia(uint64_t &valor) {
  return secuencias.tomar(valor, RESERVA_SECUENCIAS, [](uint64_t nuevo) {
    return preferencias.putULong64("limite", nuevo) == sizeof(uint64_t);
  });
}

void registrar(void *) {
  if (!montar()) {
    almacen = 3;
    vTaskDelete(nullptr);
    return;
  }
  pendientes = cola.pendientes();
  almacen = 1;
  listo = true;
  Muestra s;
  for (;;) {
    if (xQueueReceive(entrada, &s, portMAX_DELAY) != pdTRUE) continue;
    uint64_t seq;
    if (!secuencia(seq)) {
      almacen = 3;
      ++errores;
      ++descartados;
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }
    const auto json = protocolo::serializar(s, seq, DISPOSITIVO, PASO, arranque);
    // Retener este evento en RAM y reintentar ante disco lleno/error.
    for (;;) {
      xSemaphoreTake(mutexDisco, portMAX_DELAY);
      auto result = json.empty() ? registro::Cola::Resultado::ERROR : cola.guardar(seq, json);
      pendientes = cola.pendientes();
      xSemaphoreGive(mutexDisco);
      if (result == registro::Cola::Resultado::OK) { almacen = 1; break; }
      almacen = result == registro::Cola::Resultado::LLENO ? 2 : 3;
      ++errores;
      vTaskDelay(pdMS_TO_TICKS(1000));
    }
  }
}

bool enviar(const std::string &json) {
  StaticJsonDocument<1536> event;
  if (deserializeJson(event, json) || !event["evento_id"].is<const char *>()) {
    httpEstado = -100; // Registro ilegible: conservar, no saltar silenciosamente.
    return false;
  }
  WiFiClient client;
  HTTPClient http;
  http.setConnectTimeout(TIMEOUT_HTTP_MS);
  http.setTimeout(TIMEOUT_HTTP_MS);
  if (!http.begin(client, API)) { httpEstado = -101; return false; }
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(String(json.c_str()));
  httpEstado = code;
  bool ack = false;
  if ((code == 200 || code == 201) && http.getSize() >= 0 && http.getSize() <= 2048) {
    ack = protocolo::confirmar(code, http.getString().c_str(), event["evento_id"]);
  }
  http.end();
  return ack;
}

void transmitir(void *) {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  unsigned fallos = 0;
  uint32_t ultimoIntento = millis() - 15000;
  for (;;) {
    if (!wifiPermitido) {
      WiFi.setAutoReconnect(false);
      WiFi.disconnect(false, false);
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }
    if (WiFi.status() != WL_CONNECTED) {
      if (uint32_t(millis() - ultimoIntento) >= 15000) {
        WiFi.setAutoReconnect(true);
        WiFi.begin(SSID, PASSWORD, 6);
        ultimoIntento = millis();
      }
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }
    if (!listo) { vTaskDelay(pdMS_TO_TICKS(250)); continue; }
    std::string archivo, json;
    xSemaphoreTake(mutexDisco, portMAX_DELAY);
    const bool hay = cola.primero(archivo, json);
    xSemaphoreGive(mutexDisco);
    if (!hay) { vTaskDelay(pdMS_TO_TICKS(250)); continue; }
    if (enviar(json)) {
      xSemaphoreTake(mutexDisco, portMAX_DELAY);
      bool ok = cola.confirmar(archivo);
      pendientes = cola.pendientes();
      xSemaphoreGive(mutexDisco);
      if (ok) { ++confirmados; fallos = 0; }
      else { ++errores; almacen = 3; }
      vTaskDelay(pdMS_TO_TICKS(ok ? 100 : 1000));
    } else {
      ++errores;
      vTaskDelay(pdMS_TO_TICKS(registro::demora(fallos)));
      if (fallos < 5) ++fallos;
    }
  }
}
} // namespace

void iniciar() {
  entrada = xQueueCreate(COLA_RAM, sizeof(Muestra));
  mutexDisco = xSemaphoreCreateMutex();
  if (!entrada || !mutexDisco) { almacen = 4; return; }
  // Core 0 para I/O; el loop de Arduino (sensores/actuadores) corre en core 1.
  if (xTaskCreatePinnedToCore(registrar, "registro", 8192, nullptr, 1, nullptr, 0) != pdPASS ||
      xTaskCreatePinnedToCore(transmitir, "envio", 12288, nullptr, 1, nullptr, 0) != pdPASS) almacen = 4;
}

void observar(const alertar::Estado &e, const alertar::Carril &a,
              const alertar::Carril &b, const alertar::Agua &w) {
  static Muestra anterior{};
  static bool primera = true;
  static uint32_t ultima = 0;
  bool cambio = primera || strcmp(anterior.codigo, e.codigo) != 0 ||
      anterior.valido1 != a.valido || anterior.valido2 != b.valido ||
      anterior.agua != w.confirmada || anterior.pendiente != w.pendiente();
  if (!cambio && uint32_t(millis() - ultima) < MUESTRA_MS) return;
  Muestra actual{};
  strlcpy(actual.codigo, e.codigo, sizeof(actual.codigo));
  strlcpy(actual.diagnostico, e.diagnostico, sizeof(actual.diagnostico));
  actual.altura1 = a.altura; actual.altura2 = b.altura;
  actual.valido1 = a.valido; actual.valido2 = b.valido;
  actual.agua = w.confirmada; actual.pendiente = w.pendiente();
  actual.uptime = esp_timer_get_time() / 1000ULL;
  actual.fecha = time(nullptr);
  if (!entrada || xQueueSend(entrada, &actual, 0) != pdTRUE) ++descartados;
  anterior = actual; primera = false; ultima = millis();
}

void informar() {
  static uint32_t ultima = 0;
  if (uint32_t(millis() - ultima) < 5000) return;
  ultima = millis();
  Serial.printf("{\"tipo\":\"conectividad\",\"wifi\":%s,\"almacen\":%d,\"pendientes\":%u,\"cola_ram\":%u,\"confirmados\":%u,\"descartados\":%u,\"errores\":%u,\"ultimo_http\":%d}\n",
      WiFi.status() == WL_CONNECTED ? "true" : "false", almacen.load(), pendientes.load(),
      entrada ? (unsigned)uxQueueMessagesWaiting(entrada) : 0,
      confirmados.load(), descartados.load(), errores.load(), httpEstado.load());
}

void comandos() {
  while (Serial.available()) {
    switch (Serial.read()) {
      case '0': wifiPermitido = false; break;
      case '1': wifiPermitido = true; break;
      case 'r': ESP.restart(); break;
    }
  }
}
} // namespace conectividad
