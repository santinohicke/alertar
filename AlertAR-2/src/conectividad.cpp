#include "conectividad.h"
#include "conectividad_config.h"
#include "registro.h"
#include "protocolo.h"
#include "ultrasonido.h"
#include "certificado.h"
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
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
TaskHandle_t tareaEnvio = nullptr;
std::atomic<bool> listo{false}, wifiPermitido{true};
std::atomic<bool> envioBloqueado{false};
bool falloTareas = false;
std::atomic<unsigned> pendientes{0}, descartados{0}, confirmados{0}, errores{0};
std::atomic<int> httpEstado{0};
std::atomic<bool> envioEnCurso{false};
std::atomic<uint32_t> inicioEnvio{0}, duracionEnvio{0};
// 0 iniciando, 1 listo, 2 lleno, 3 error almacenamiento, 4 error tareas.
std::atomic<int> almacen{0};
Preferences preferencias;
protocolo::Secuencias secuencias(0);
char arranque[33];
char instalacion[33];
bool reservaLista = false;
uint64_t baseRemota = 0;
uint32_t ciclos = 0, maxCiclo = 0, ultimoCiclo = 0;
WiFiClientSecure clienteTLS; // Usado únicamente por la tarea de red.
HTTPClient clienteHTTP; // Evitar destruir el cliente y renegociar TLS en cada pendiente.
unsigned reintentarDespuesMs = 0;

bool prepararHTTP(HTTPClient &http, const char *url) {
  if (!API_KEY[0]) { httpEstado = -103; return false; }
  // La validación del certificado requiere reloj. Esperar NTP no bloquea sensores.
  if (time(nullptr) < 1704067200) { httpEstado = -102; return false; }
  http.setConnectTimeout(TIMEOUT_HTTP_MS);
  http.setTimeout(TIMEOUT_HTTP_MS);
  http.setReuse(true);
  if (!http.begin(clienteTLS, url)) { httpEstado = -101; return false; }
  const char *headers[] = {"Retry-After"};
  http.collectHeaders(headers, 1);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  return true;
}

void registrarEspera(HTTPClient &http, int code) {
  if (code == 429 || code == 503) {
    const long seconds = http.header("Retry-After").toInt();
    reintentarDespuesMs = static_cast<unsigned>(std::max(5L, std::min(60L, seconds))) * 1000;
  }
}

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
    if (!LittleFS.exists(path.c_str())) return false;
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
  if (preferencias.isKey("instalacion")) {
    auto guardada = preferencias.getString("instalacion", "");
    if (guardada.length() != 32) return false;
    strlcpy(instalacion, guardada.c_str(), sizeof(instalacion));
  } else {
    strlcpy(instalacion, arranque, sizeof(instalacion));
    if (!preferencias.putString("instalacion", instalacion)) return false;
  }
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
  cola.limpiar();
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
    const auto json = protocolo::serializar(s, seq, DISPOSITIVO, PASO, arranque, instalacion);
    // Retener este evento en RAM y reintentar ante disco lleno/error.
    for (;;) {
      xSemaphoreTake(mutexDisco, portMAX_DELAY);
      auto result = json.empty() ? registro::Cola::Resultado::ERROR : cola.guardar(seq, json);
      pendientes = cola.pendientes();
      xSemaphoreGive(mutexDisco);
      if (result == registro::Cola::Resultado::OK) {
        almacen = 1;
        if (tareaEnvio) xTaskNotifyGive(tareaEnvio);
        break;
      }
      almacen = result == registro::Cola::Resultado::LLENO ? 2 : 3;
      ++errores;
      vTaskDelay(pdMS_TO_TICKS(1000));
    }
  }
}

bool reservar() {
  auto &http = clienteHTTP;
  if (!prepararHTTP(http, RESERVA_API)) return false;
  int code = http.POST(String("{\"instalacion_id\":\"") + instalacion + "\"}");
  httpEstado = code;
  registrarEspera(http, code);
  bool ok = false;
  if ((code == 200 || code == 201) && http.getSize() >= 0 && http.getSize() <= 1024) {
    StaticJsonDocument<512> doc;
    if (!deserializeJson(doc, http.getString()) && doc["base"].is<uint64_t>() &&
        doc["tamano"].as<uint64_t>() == (1ULL << 32) &&
        doc["base"].as<uint64_t>() <= INT64_MAX - (1ULL << 32) &&
        doc["instalacion_id"].is<const char *>() && !strcmp(doc["instalacion_id"], instalacion)) {
      baseRemota = doc["base"].as<uint64_t>();
      reservaLista = true; ok = true;
    }
  }
  http.end();
  if (!ok) clienteTLS.stop();
  return ok;
}

bool enviar(const std::string &json) {
  StaticJsonDocument<1536> event;
  if (deserializeJson(event, json) || !event["evento_id"].is<const char *>()) {
    httpEstado = -100; // Registro ilegible: conservar, no saltar silenciosamente.
    return false;
  }
  // El log guarda secuencia local. La API asigna un rango estable por flash:
  // detener/iniciar Wokwi con flash virgen no reutiliza identidades históricas.
  // Logs del firmware anterior (sin instalación en su ID) se envían intactos.
  std::string prefijo = std::string(DISPOSITIVO) + "-" + instalacion + "-";
  const char *id = event["evento_id"];
  if (strncmp(id, prefijo.c_str(), prefijo.size()) == 0) {
    if (!reservaLista && !reservar()) return false;
    if (!event["secuencia"].is<uint64_t>() || event["secuencia"].as<uint64_t>() >= (1ULL << 32)) {
      httpEstado = -100; return false;
    }
    event["secuencia"] = baseRemota + event["secuencia"].as<uint64_t>();
  }
  String payload;
  serializeJson(event, payload);
  auto &http = clienteHTTP;
  if (!prepararHTTP(http, API)) return false;
  int code = http.POST(payload);
  httpEstado = code;
  registrarEspera(http, code);
  bool ack = false;
  if ((code == 200 || code == 201) && http.getSize() >= 0 && http.getSize() <= 2048) {
    ack = protocolo::confirmar(code, http.getString().c_str(), event["evento_id"]);
  }
  http.end();
  if (!ack) clienteTLS.stop();
  return ack;
}

void transmitir(void *) {
  clienteTLS.setCACert(RAIZ_HTTPS);
  clienteTLS.setHandshakeTimeout(TIMEOUT_TLS_S);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  unsigned fallos = 0;
  uint32_t ultimoIntento = millis() - 15000;
  bool desconectadoPorUsuario = false;
  std::string archivo, json; // Se reutiliza el mismo registro durante los reintentos.
  for (;;) {
    if (!wifiPermitido) {
      if (!desconectadoPorUsuario) {
        clienteTLS.stop();
        WiFi.setAutoReconnect(false);
        WiFi.disconnect(false, false);
        desconectadoPorUsuario = true;
      }
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
      continue;
    }
    if (desconectadoPorUsuario) {
      desconectadoPorUsuario = false;
      ultimoIntento = millis() - 15000;
    }
    if (WiFi.status() != WL_CONNECTED) {
      if (uint32_t(millis() - ultimoIntento) >= 15000) {
        WiFi.setAutoReconnect(true);
        WiFi.begin(SSID, PASSWORD, 6);
        ultimoIntento = millis();
      }
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
      continue;
    }
    if (!listo || envioBloqueado || pendientes == 0) {
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
      continue;
    }
    if (json.empty()) {
      xSemaphoreTake(mutexDisco, portMAX_DELAY);
      const bool hay = cola.primero(archivo, json);
      xSemaphoreGive(mutexDisco);
      if (!hay) {
        almacen = 3; ++errores;
        vTaskDelay(pdMS_TO_TICKS(5000)); continue;
      }
    }
    reintentarDespuesMs = 0;
    inicioEnvio = millis();
    envioEnCurso = true;
    const bool enviado = enviar(json);
    duracionEnvio = uint32_t(millis() - inicioEnvio.load());
    envioEnCurso = false;
    if (enviado) {
      xSemaphoreTake(mutexDisco, portMAX_DELAY);
      bool ok = cola.confirmar(archivo);
      pendientes = cola.pendientes();
      xSemaphoreGive(mutexDisco);
      if (ok) { ++confirmados; fallos = 0; json.clear(); }
      else { ++errores; almacen = 3; }
      // La espera sigue siendo obligatoria: las notificaciones de nuevas
      // muestras no deben saltarse el límite de ritmo ni Retry-After.
      vTaskDelay(pdMS_TO_TICKS(pendientes.load() > 0 ? RECUPERACION_MS : ENTRE_ENVIOS_MS));
    } else {
      ++errores;
      if (httpEstado == 400 || httpEstado == 401 || httpEstado == 403 || httpEstado == 409 ||
          httpEstado == 413 || httpEstado == 422 || httpEstado == -100 || httpEstado == -103)
        envioBloqueado = true; // Error permanente: conservar y esperar /reintentar.
      vTaskDelay(pdMS_TO_TICKS(std::max(registro::demora(fallos), reintentarDespuesMs)));
      if (fallos < 5) ++fallos;
    }
  }
}
} // namespace

void iniciar() {
  entrada = xQueueCreate(COLA_RAM, sizeof(Muestra));
  mutexDisco = xSemaphoreCreateMutex();
  if (!entrada || !mutexDisco) { falloTareas = true; almacen = 4; return; }
  // Core 0 para I/O; el loop de Arduino (sensores/actuadores) corre en core 1.
  if (xTaskCreatePinnedToCore(registrar, "registro", 8192, nullptr, 1, nullptr, 0) != pdPASS ||
      // TLS puede consumir varios segundos de CPU en Wokwi. Compartir prioridad
      // con IDLE0 permite atender el watchdog incluso durante el cálculo TLS.
      xTaskCreatePinnedToCore(transmitir, "envio", 12288, nullptr, tskIDLE_PRIORITY, &tareaEnvio, 0) != pdPASS) {
    falloTareas = true; almacen = 4;
  }
}

void observar(const alertar::Estado &e, const alertar::Carril &a,
              const alertar::Carril &b, const alertar::Agua &w) {
  const uint32_t ahora = millis();
  if (ultimoCiclo) maxCiclo = std::max(maxCiclo, uint32_t(ahora - ultimoCiclo));
  ultimoCiclo = ahora; ++ciclos;
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
  if (uint32_t(millis() - ultima) < DIAGNOSTICO_MS) return;
  ultima = millis();
  const bool enCurso = envioEnCurso.load();
  const uint32_t tiempoEnvio = enCurso ? uint32_t(millis() - inicioEnvio.load()) : duracionEnvio.load();
  Serial.printf("{\"tipo\":\"conectividad\",\"uptime_ms\":%lu,\"ciclos\":%lu,\"max_ciclo_ms\":%lu,\"fallos_eco\":%lu,\"wifi\":%s,\"bloqueado\":%s,\"almacen\":%d,\"pendientes\":%u,\"cola_ram\":%u,\"confirmados\":%u,\"descartados\":%u,\"errores\":%u,\"ultimo_http\":%d,\"envio_en_curso\":%s,\"envio_ms\":%lu,\"heap_libre\":%u,\"heap_minimo\":%u}\n",
      (unsigned long)millis(), (unsigned long)ciclos, (unsigned long)maxCiclo,
      (unsigned long)ultrasonido::fallos(), WiFi.status() == WL_CONNECTED ? "true" : "false",
      envioBloqueado ? "true" : "false", falloTareas ? 4 : almacen.load(), pendientes.load(),
      entrada ? (unsigned)uxQueueMessagesWaiting(entrada) : 0,
      confirmados.load(), descartados.load(), errores.load(), httpEstado.load(),
      enCurso ? "true" : "false", (unsigned long)tiempoEnvio,
      ESP.getFreeHeap(), ESP.getMinFreeHeap());
}

void comandos() {
  static char linea[32];
  static size_t usados = 0;
  static bool desbordada = false;
  // Presupuesto acotado: pegar texto no puede monopolizar el loop de sensores.
  for (unsigned n = 0; n < 16 && Serial.available(); ++n) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      linea[usados] = 0;
      if (!desbordada) {
        if (!strcmp(linea, "/wifi off")) wifiPermitido = false;
        else if (!strcmp(linea, "/wifi on")) wifiPermitido = true;
        else if (!strcmp(linea, "/reintentar")) envioBloqueado = false;
        else if (!strcmp(linea, "/reiniciar")) ESP.restart();
        if (tareaEnvio) xTaskNotifyGive(tareaEnvio);
      }
      usados = 0; desbordada = false;
    } else if (usados + 1 < sizeof(linea)) {
      linea[usados++] = c;
    } else {
      desbordada = true;
    }
  }
}
} // namespace conectividad
