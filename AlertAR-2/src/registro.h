#pragma once
#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

// Interfaz pequeña para probar la misma cola persistente en PC y ESP32.
namespace registro {
struct Disco {
  virtual ~Disco() = default;
  virtual std::vector<std::string> listar(const std::string &directorio) = 0;
  virtual bool leer(const std::string &ruta, std::string &texto) = 0;
  virtual bool escribir(const std::string &ruta, const std::string &texto) = 0;
  virtual bool mover(const std::string &desde, const std::string &hasta) = 0;
  virtual bool borrar(const std::string &ruta) = 0;
};

inline std::string nombre(uint64_t secuencia) {
  auto digits = std::to_string(secuencia);
  return std::string(20 - digits.size(), '0') + digits + ".log";
}

inline bool esLog(const std::string &s) {
  return s.size() == 24 && s.substr(20) == ".log" &&
      s.find_first_not_of("0123456789") == 20;
}

class Cola {
  Disco &disco;
  size_t capacidad, retenidos;
  std::vector<std::string> archivos(const std::string &dir) {
    auto result = disco.listar(dir);
    result.erase(std::remove_if(result.begin(), result.end(),
        [](const std::string &s) { return !esLog(s); }), result.end());
    std::sort(result.begin(), result.end());
    return result;
  }
 public:
  enum class Resultado { OK, LLENO, ERROR };
  Cola(Disco &d, size_t cap, size_t ret) : disco(d), capacidad(cap), retenidos(ret) {}
  size_t pendientes() { return archivos("/pendientes").size(); }
  Resultado guardar(uint64_t secuencia, const std::string &json) {
    auto final = "/pendientes/" + nombre(secuencia);
    std::string previo;
    if (disco.leer(final, previo)) return previo == json ? Resultado::OK : Resultado::ERROR;
    if (pendientes() >= capacidad) return Resultado::LLENO;
    // El temporal nunca se envía. Solo el rename publica un registro completo.
    if (!disco.escribir("/evento.tmp", json)) return Resultado::ERROR;
    if (!disco.leer("/evento.tmp", previo) || previo != json) return Resultado::ERROR;
    return disco.mover("/evento.tmp", final) ? Resultado::OK : Resultado::ERROR;
  }
  bool primero(std::string &archivo, std::string &json) {
    auto pending = archivos("/pendientes");
    if (pending.empty()) return false;
    archivo = pending.front();
    return disco.leer("/pendientes/" + archivo, json);
  }
  bool confirmar(const std::string &archivo) {
    if (!esLog(archivo)) return false;
    // Si el reinicio ocurrió antes del rename se reintentará el mismo JSON.
    if (!disco.mover("/pendientes/" + archivo, "/enviados/" + archivo)) return false;
    auto sent = archivos("/enviados");
    for (size_t i = 0; i + retenidos < sent.size(); ++i) {
      if (!disco.borrar("/enviados/" + sent[i])) return false;
    }
    return true;
  }
};

inline uint32_t demora(unsigned fallos) {
  return 1000U << std::min(fallos, 5U); // 1, 2, 4, 8, 16, 32 s
}
} // namespace registro
