#include "../AlertAR-2/src/protocolo.h"
#include <cassert>
#include <iostream>

int main() {
  protocolo::Muestra s{};
  strcpy(s.codigo, "ERR-003");
  strcpy(s.diagnostico, "Sensor \"invalido\"");
  s.valido1 = false; s.valido2 = true; s.altura2 = 13.5;
  s.uptime = 12345;
  std::string json = protocolo::serializar(s, 42, "esp32-01", "tunel-01", "boot-prueba");
  StaticJsonDocument<1536> parsed;
  assert(!deserializeJson(parsed, json));
  assert(parsed["medido_en"].isNull());
  assert(parsed["obstruccion_carril1_cm"].isNull());
  assert(parsed["obstruccion_carril2_cm"].as<float>() == 13.5);
  assert(parsed["secuencia"].as<int>() == 42);
  const std::string ack = "{\"guardado\":true,\"evento_id\":\"esp32-01-42\"}";
  assert(protocolo::confirmar(201, ack, "esp32-01-42"));
  assert(protocolo::confirmar(200, ack, "esp32-01-42"));
  for (int code : {-1, 400, 409, 500, 503}) assert(!protocolo::confirmar(code, ack, "esp32-01-42"));
  assert(!protocolo::confirmar(201, ack, "otra-identidad"));
  assert(!protocolo::confirmar(201, "{\"guardado\":\"true\",\"evento_id\":\"esp32-01-42\"}", "esp32-01-42"));
  assert(!protocolo::confirmar(201, "{", "esp32-01-42"));
  uint64_t persistido = 0, value = 9999;
  protocolo::Secuencias seq(0);
  auto guardar = [&](uint64_t v) { persistido = v; return true; };
  assert(!seq.tomar(value, 1024, [](uint64_t) { return false; }));
  assert(value == 9999); // No entregar una secuencia si falla NVS.
  assert(seq.tomar(value, 1024, guardar) && value == 0 && persistido == 1024);
  assert(seq.tomar(value, 1024, guardar) && value == 1 && persistido == 1024);
  protocolo::Secuencias reinicio(persistido);
  assert(reinicio.tomar(value, 1024, guardar) && value == 1024 && persistido == 2048);
  protocolo::Secuencias agotada(INT64_MAX);
  assert(!agotada.tomar(value, 1024, guardar));
  std::cout << json << '\n'; // También se valida con la API Python real.
  s.fecha = 1767225600;
  std::cout << protocolo::serializar(s, 43, "esp32-01", "tunel-01", "boot-prueba") << '\n';
}
