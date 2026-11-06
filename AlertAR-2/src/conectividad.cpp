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
#include <esp_sntp.h>
#include <esp_timer.h>
#include <esp_task_wdt.h>
#include <sys/time.h>
#include <time.h>

namespace conectividad {
namespace {
using namespace conexion_config;
using protocolo::Muestra;
QueueHandle_t entrada = nullptr;
SemaphoreHandle_t mutexDisco = nullptr;
TaskHandle_t tareaEnvio = nullptr, tareaRegistro = nullptr;
constexpr time_t RELOJ_VALIDO = 1704067200; // 2024-01-01: antes de esto el reloj no se sincronizó.
std::atomic<uint32_t> primerAck{0}; // millis() del primer evento confirmado por el servidor.
std::atomic<unsigned> loteMaximo{0};
std::atomic<unsigned> ajustesReloj{0};
std::atomic<int32_t> ultimoDesfaseMs{0}; // servidor - ESP en la última corrección.
bool loteDisponible = true; // Se apaga si el servidor no tiene /api/eventos/lote (404).
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
  if (time(nullptr) < RELOJ_VALIDO) { httpEstado = -102; return false; }
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
    // No borrar la tarea: informar() consulta su pila con este handle.
    for (;;) vTaskDelay(portMAX_DELAY);
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
  // Cortar solo si falló el transporte. Si el servidor respondió (429, 4xx, 5xx) la conexión
  // sigue sana y reutilizarla evita otro handshake TLS (casi un minuto en Wokwi).
  if (code < 0) clienteTLS.stop();
  return ok;
}

bool errorPermanente(int code) {
  return code == 400 || code == 401 || code == 403 || code == 409 || code == 413 ||
      code == 422 || code == -100 || code == -103;
}

// Convierte un registro del log en el JSON a enviar y devuelve su evento_id.
bool preparar(const std::string &json, String &salida, std::string &id) {
  DynamicJsonDocument event(1536);
  if (deserializeJson(event, json) || !event["evento_id"].is<const char *>()) {
    httpEstado = -100; // Registro ilegible: conservar, no saltar silenciosamente.
    return false;
  }
  id = event["evento_id"].as<const char *>();
  // El log guarda secuencia local. La API asigna un rango estable por flash:
  // detener/iniciar Wokwi con flash virgen no reutiliza identidades históricas.
  // Logs del firmware anterior (sin instalación en su ID) se envían intactos.
  const std::string prefijo = std::string(DISPOSITIVO) + "-" + instalacion + "-";
  if (id.compare(0, prefijo.size(), prefijo) == 0) {
    if (!reservaLista && !reservar()) return false;
    if (!event["secuencia"].is<uint64_t>() || event["secuencia"].as<uint64_t>() >= (1ULL << 32)) {
      httpEstado = -100; return false;
    }
    event["secuencia"] = baseRemota + event["secuencia"].as<uint64_t>();
  }
  salida = "";
  serializeJson(event, salida);
  return true;
}

// Wokwi simula más lento que el tiempo real (64-93 % medido, menos durante el TLS), así que el
// reloj del ESP se atrasa entre sincronizaciones NTP y medido_en aparecía 20 s "viejo". Cada
// respuesta del servidor trae su hora (recibido_en): se usa para corregir el reloj sin pedir
// NTP más seguido. Solo con pedidos cortos, así la mitad de la demora acota el error.
void ajustarReloj(const char *recibido, uint32_t demoraMs) {
  int anio, mes, dia, hora, minuto, segundo;
  long micro = 0;
  if (!recibido || demoraMs > 3000 ||
      sscanf(recibido, "%4d-%2d-%2dT%2d:%2d:%2d.%6ld", &anio, &mes, &dia, &hora, &minuto,
             &segundo, &micro) < 6) return;
  struct tm t = {};
  t.tm_year = anio - 1900; t.tm_mon = mes - 1; t.tm_mday = dia;
  t.tm_hour = hora; t.tm_min = minuto; t.tm_sec = segundo;
  const time_t servidor = mktime(&t); // La zona horaria es UTC: configTime(0, 0, ...).
  if (servidor < RELOJ_VALIDO) return;
  const int64_t servidorMs = int64_t(servidor) * 1000 + micro / 1000 + demoraMs / 2;
  timeval ahora;
  gettimeofday(&ahora, nullptr);
  const int64_t desfase = servidorMs - (int64_t(ahora.tv_sec) * 1000 + ahora.tv_usec / 1000);
  if (desfase > -300 && desfase < 300) return;
  const timeval nuevo = {time_t(servidorMs / 1000), suseconds_t((servidorMs % 1000) * 1000)};
  settimeofday(&nuevo, nullptr);
  ultimoDesfaseMs = int32_t(std::max<int64_t>(INT32_MIN, std::min<int64_t>(INT32_MAX, desfase)));
  ++ajustesReloj;
}

// Envía los registros en un pedido (o uno solo por /api/eventos) y marca en `ok` los que el
// servidor confirmó. Devuelve cuántos se confirmaron.
unsigned enviar(const std::vector<std::string> &jsons, std::vector<bool> &ok) {
  ok.assign(jsons.size(), false);
  if (jsons.empty()) return 0;
  const bool lote = loteDisponible && jsons.size() > 1;
  std::vector<std::string> ids(jsons.size());
  String payload, evento;
  payload.reserve(lote ? jsons.size() * 640 + 16 : 640);
  if (lote) payload = "{\"eventos\":[";
  for (size_t i = 0; i < jsons.size(); ++i) {
    if (!preparar(jsons[i], evento, ids[i])) return 0;
    if (lote && i) payload += ',';
    payload += evento;
  }
  if (lote) payload += "]}";
  auto &http = clienteHTTP;
  if (!prepararHTTP(http, lote ? API_LOTE : API)) return 0;
  const uint32_t inicioPost = millis();
  const int code = http.POST(payload);
  const uint32_t demoraPost = millis() - inicioPost;
  httpEstado = code;
  registrarEspera(http, code);
  unsigned confirmadosAhora = 0;
  const int size = http.getSize();
  if ((code == 200 || code == 201) && size >= 0 && size <= (lote ? 8192 : 2048)) {
    const String respuesta = http.getString();
    if (!lote) {
      ok[0] = protocolo::confirmar(code, respuesta.c_str(), ids[0].c_str());
      confirmadosAhora = ok[0];
      StaticJsonDocument<512> doc;
      // Un duplicado trae la hora de la primera recepción: no sirve para el reloj.
      if (ok[0] && code == 201 && !deserializeJson(doc, respuesta))
        ajustarReloj(doc["recibido_en"] | (const char *)nullptr, demoraPost);
    } else {
      DynamicJsonDocument doc(6144);
      JsonArray resultados;
      if (!deserializeJson(doc, respuesta)) resultados = doc["resultados"];
      if (resultados.size() != ids.size()) httpEstado = -100;
      for (size_t i = 0; i < ids.size() && resultados.size() == ids.size(); ++i) {
        JsonObject r = resultados[i];
        if ((r["guardado"] | false) && strcmp(r["evento_id"] | "", ids[i].c_str()) == 0) {
          ok[i] = true; ++confirmadosAhora;
          if (r["estado"] == 201) ajustarReloj(r["recibido_en"] | (const char *)nullptr, demoraPost);
        } else {
          httpEstado = r["estado"].is<int>() ? r["estado"].as<int>() : -100;
        }
      }
    }
  }
  http.end();
  if (code < 0) clienteTLS.stop(); // Ver reservar(): conservar la conexión si hubo respuesta.
  if (lote && (code == 401 || code == 404 || code == 405)) {
    // Servidor sin /api/eventos/lote (con autenticación una ruta desconocida da 401): seguir
    // de a uno por /api/eventos. Si la clave fuera realmente inválida, ese pedido dará el 401
    // definitivo y ahí sí se bloquea.
    loteDisponible = false;
    httpEstado = -104;
  }
  return confirmadosAhora;
}

void alSincronizarReloj(struct timeval *) {
  if (tareaEnvio) xTaskNotifyGive(tareaEnvio);
}

void transmitir(void *) {
  clienteTLS.setCACert(RAIZ_HTTPS);
  clienteTLS.setHandshakeTimeout(TIMEOUT_TLS_S);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  sntp_set_time_sync_notification_cb(alSincronizarReloj);
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  // En hardware corrige deriva normal; en Wokwi evita que el tiempo simulado
  // se aleje del reloj real de la API. No modifica la fecha ya persistida de
  // eventos pendientes, que deben seguir apareciendo como históricos.
  esp_sntp_set_sync_interval(SINCRONIZACION_RELOJ_MS);
  unsigned fallos = 0;
  uint32_t ultimoIntento = millis() - 15000;
  bool desconectadoPorUsuario = false, conectado = false;
  // Se vuelve a elegir el lote en cada intento: si llegó una medición nueva, va primero.
  std::vector<std::string> archivos, jsons;
  std::vector<bool> ok;
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
      conectado = false;
      if (uint32_t(millis() - ultimoIntento) >= 15000) {
        WiFi.setAutoReconnect(true);
        WiFi.begin(SSID, PASSWORD, 6);
        ultimoIntento = millis();
      }
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
      continue;
    }
    if (!conectado) {
      conectado = true;
      // configTime() corrió sin red: lwIP reintenta recién a los 15 s y con espera creciente.
      // Pedir la hora apenas hay Wi-Fi la trae en uno o dos segundos.
      if (time(nullptr) < RELOJ_VALIDO) sntp_restart();
    }
    if (!listo || envioBloqueado || pendientes == 0) {
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
      continue;
    }
    if (time(nullptr) < RELOJ_VALIDO) {
      // Esperar la hora no es un fallo: no suma errores ni activa la espera creciente.
      // alSincronizarReloj() despierta la tarea en cuanto llega.
      httpEstado = -102;
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
      continue;
    }
    if (httpEstado == -102) httpEstado = 0; // El diagnóstico no debe mostrar la espera vieja.
    xSemaphoreTake(mutexDisco, portMAX_DELAY);
    const bool hay = cola.lote(loteDisponible ? LOTE_MAX : 1, archivos, jsons);
    xSemaphoreGive(mutexDisco);
    if (!hay) {
      almacen = 3; ++errores;
      vTaskDelay(pdMS_TO_TICKS(5000)); continue;
    }
    reintentarDespuesMs = 0;
    inicioEnvio = millis();
    envioEnCurso = true;
    const unsigned enviados = enviar(jsons, ok);
    duracionEnvio = uint32_t(millis() - inicioEnvio.load());
    envioEnCurso = false;
    bool guardado = true;
    if (enviados) {
      xSemaphoreTake(mutexDisco, portMAX_DELAY);
      for (size_t i = 0; i < archivos.size(); ++i)
        if (ok[i]) guardado = cola.confirmar(archivos[i]) && guardado;
      pendientes = cola.pendientes();
      xSemaphoreGive(mutexDisco);
      confirmados += enviados;
      if (!primerAck) primerAck = millis();
      if (enviados > loteMaximo) loteMaximo = enviados;
      if (!guardado) { ++errores; almacen = 3; } // Se reenvía: el servidor lo toma como duplicado.
    }
    if (enviados == archivos.size()) {
      fallos = 0;
      // La espera sigue siendo obligatoria: las notificaciones de nuevas
      // muestras no deben saltarse el límite de ritmo ni Retry-After.
      vTaskDelay(pdMS_TO_TICKS(pendientes.load() > 0 ? RECUPERACION_MS : ENTRE_ENVIOS_MS));
    } else {
      ++errores;
      if (errorPermanente(httpEstado))
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
  // El handshake TLS ocupa el CPU decenas de segundos seguidos en Wokwi. Antes "envio"
  // compartía prioridad con IDLE0 para no disparar el watchdog, pero en este SDK la tarea idle
  // no cede su turno y el TLS recibía la mitad del core 0. Ahora "envio" corre con prioridad
  // normal y el watchdog se estira por encima del timeout TLS: sigue reiniciando la placa si
  // el core 0 queda colgado de verdad. (disableCore0WDT() falló en Wokwi en el primer arranque.)
  if (esp_task_wdt_init(WATCHDOG_S, true) != ESP_OK)
    Serial.println("{\"tipo\":\"error\",\"detalle\":\"no se pudo configurar el watchdog\"}");
  if (xTaskCreatePinnedToCore(registrar, "registro", 8192, nullptr, 1, &tareaRegistro, 0) != pdPASS ||
      xTaskCreatePinnedToCore(transmitir, "envio", 12288, nullptr, 1, &tareaEnvio, 0) != pdPASS) {
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
  static int64_t ultimaReal = -1;
  bool cambio = primera || strcmp(anterior.codigo, e.codigo) != 0 ||
      anterior.valido1 != a.valido || anterior.valido2 != b.valido ||
      anterior.agua != w.confirmada || anterior.pendiente != w.pendiente();
  // Con el reloj en hora, el intervalo se mide en tiempo real: Wokwi simula más lento y con
  // millis() las mediciones salían cada 6-8 s reales en lugar de 5. Sin hora, o si el reloj
  // saltó hacia atrás, vale millis(); el doble del intervalo es el límite de seguridad.
  timeval tv;
  gettimeofday(&tv, nullptr);
  const int64_t real = tv.tv_sec >= RELOJ_VALIDO ? int64_t(tv.tv_sec) * 1000 + tv.tv_usec / 1000 : -1;
  const uint32_t transcurrido = uint32_t(millis() - ultima);
  const bool vencio = (real >= 0 && ultimaReal >= 0 && real >= ultimaReal)
      ? real - ultimaReal >= MUESTRA_MS || transcurrido >= 2 * MUESTRA_MS
      : transcurrido >= MUESTRA_MS;
  if (!cambio && !vencio) return;
  Muestra actual{};
  strlcpy(actual.codigo, e.codigo, sizeof(actual.codigo));
  strlcpy(actual.diagnostico, e.diagnostico, sizeof(actual.diagnostico));
  actual.altura1 = a.altura; actual.altura2 = b.altura;
  actual.valido1 = a.valido; actual.valido2 = b.valido;
  actual.agua = w.confirmada; actual.pendiente = w.pendiente();
  actual.uptime = esp_timer_get_time() / 1000ULL;
  actual.fecha = time(nullptr);
  if (!entrada || xQueueSend(entrada, &actual, 0) != pdTRUE) ++descartados;
  anterior = actual; primera = false; ultima = millis(); ultimaReal = real;
}

void informar() {
  static uint32_t ultima = 0;
  if (uint32_t(millis() - ultima) < DIAGNOSTICO_MS) return;
  ultima = millis();
  const bool enCurso = envioEnCurso.load();
  const uint32_t tiempoEnvio = enCurso ? uint32_t(millis() - inicioEnvio.load()) : duracionEnvio.load();
  // pila_*: bytes de pila que nunca se usaron en cada tarea (margen ante desbordes).
  Serial.printf("{\"tipo\":\"conectividad\",\"uptime_ms\":%lu,\"ciclos\":%lu,\"max_ciclo_ms\":%lu,\"fallos_eco\":%lu,\"wifi\":%s,\"reloj\":%s,\"bloqueado\":%s,\"almacen\":%d,\"pendientes\":%u,\"cola_ram\":%u,\"confirmados\":%u,\"descartados\":%u,\"errores\":%u,\"ultimo_http\":%d,\"envio_en_curso\":%s,\"envio_ms\":%lu,\"primer_ack_ms\":%lu,\"lote_max\":%u,\"ajustes_reloj\":%u,\"desfase_reloj_ms\":%ld,\"pila_envio\":%u,\"pila_registro\":%u,\"heap_libre\":%u,\"heap_minimo\":%u}\n",
      (unsigned long)millis(), (unsigned long)ciclos, (unsigned long)maxCiclo,
      (unsigned long)ultrasonido::fallos(), WiFi.status() == WL_CONNECTED ? "true" : "false",
      time(nullptr) >= RELOJ_VALIDO ? "true" : "false",
      envioBloqueado ? "true" : "false", falloTareas ? 4 : almacen.load(), pendientes.load(),
      entrada ? (unsigned)uxQueueMessagesWaiting(entrada) : 0,
      confirmados.load(), descartados.load(), errores.load(), httpEstado.load(),
      enCurso ? "true" : "false", (unsigned long)tiempoEnvio,
      (unsigned long)primerAck.load(), loteMaximo.load(), ajustesReloj.load(), (long)ultimoDesfaseMs.load(),
      tareaEnvio ? (unsigned)uxTaskGetStackHighWaterMark(tareaEnvio) : 0,
      tareaRegistro ? (unsigned)uxTaskGetStackHighWaterMark(tareaRegistro) : 0,
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
