#pragma once
#include <ArduinoJson.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <string>

namespace protocolo {
struct Muestra {
  char codigo[8];
  char diagnostico[160];
  float altura1, altura2;
  bool valido1, valido2, agua, pendiente;
  uint64_t uptime;
  time_t fecha;
};

inline std::string serializar(const Muestra &s, uint64_t sec, const char *dispositivo,
                             const char *paso, const char *arranque) {
  StaticJsonDocument<1536> doc;
  char id[81];
  snprintf(id, sizeof(id), "%s-%llu", dispositivo, (unsigned long long)sec);
  doc["version"] = 1;
  doc["evento_id"] = id;
  doc["dispositivo_id"] = dispositivo;
  doc["paso_id"] = paso;
  doc["arranque_id"] = arranque;
  doc["secuencia"] = sec;
  doc["uptime_ms"] = s.uptime;
  doc["medido_en"] = nullptr;
  if (s.fecha >= 1704067200) {
    struct tm utc;
    gmtime_r(&s.fecha, &utc);
    char fecha[25];
    strftime(fecha, sizeof(fecha), "%Y-%m-%dT%H:%M:%SZ", &utc);
    doc["medido_en"] = fecha;
  }
  doc["codigo"] = s.codigo;
  doc["diagnostico"] = s.diagnostico;
  doc["obstruccion_carril1_cm"] = nullptr;
  doc["obstruccion_carril2_cm"] = nullptr;
  if (s.valido1) doc["obstruccion_carril1_cm"] = s.altura1;
  if (s.valido2) doc["obstruccion_carril2_cm"] = s.altura2;
  doc["sensor1_valido"] = s.valido1;
  doc["sensor2_valido"] = s.valido2;
  doc["agua_activa"] = s.agua;
  doc["agua_pendiente"] = s.pendiente;
  std::string result;
  if (!doc.overflowed()) serializeJson(doc, result);
  return result;
}

inline bool confirmar(int codigo, const std::string &respuesta, const char *evento) {
  if ((codigo != 200 && codigo != 201) || respuesta.size() > 2048) return false;
  StaticJsonDocument<1024> doc;
  if (deserializeJson(doc, respuesta)) return false;
  return doc["guardado"].is<bool>() && doc["guardado"].as<bool>() &&
      doc["evento_id"].is<const char *>() && strcmp(doc["evento_id"], evento) == 0;
}

// Reservar rangos en NVS antes de usarlos evita reutilizar IDs tras un reset.
// Guardar devuelve true solo si la escritura persistente fue exitosa.
class Secuencias {
  uint64_t siguiente, limite;
 public:
  explicit Secuencias(uint64_t persistido) : siguiente(persistido), limite(persistido) {}
  template<class Guardar>
  bool tomar(uint64_t &valor, uint64_t bloque, Guardar guardar) {
    if (siguiente == limite) {
      if (!bloque || bloque > INT64_MAX || limite > INT64_MAX - bloque) return false;
      uint64_t nuevo = limite + bloque;
      if (!guardar(nuevo)) return false;
      limite = nuevo;
    }
    valor = siguiente++;
    return true;
  }
};
} // namespace protocolo
