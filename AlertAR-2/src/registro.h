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
  bool cargado = false;
  std::vector<std::string> indice, enviados;
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
  void cargar() {
    if (cargado) return;
    indice = archivos("/pendientes");
    enviados = archivos("/enviados");
    cargado = true;
  }
  size_t pendientes() { cargar(); return indice.size(); }
  Resultado guardar(uint64_t secuencia, const std::string &json) {
    cargar();
    auto name = nombre(secuencia);
    auto final = "/pendientes/" + name;
    std::string previo;
    if (std::binary_search(indice.begin(), indice.end(), name))
      return disco.leer(final, previo) && previo == json ? Resultado::OK : Resultado::ERROR;
    if (std::binary_search(enviados.begin(), enviados.end(), name)) return Resultado::ERROR;
    if (pendientes() >= capacidad) return Resultado::LLENO;
    // El temporal nunca se envía. Solo el rename publica un registro completo.
    if (!disco.escribir("/evento.tmp", json)) return Resultado::ERROR;
    if (!disco.leer("/evento.tmp", previo) || previo != json) return Resultado::ERROR;
    if (!disco.mover("/evento.tmp", final)) return Resultado::ERROR;
    indice.insert(std::lower_bound(indice.begin(), indice.end(), name), name);
    return Resultado::OK;
  }
  bool primero(std::string &archivo, std::string &json) {
    cargar();
    if (indice.empty()) return false;
    archivo = indice.front();
    return disco.leer("/pendientes/" + archivo, json);
  }
  // Lote de hasta `maximo` registros: primero el más nuevo (el panel muestra el
  // estado actual con el primer envío) y después los más viejos, en orden, para
  // ir completando el historial. Devuelve false si algún registro no se pudo leer.
  bool lote(size_t maximo, std::vector<std::string> &archivos, std::vector<std::string> &jsons) {
    cargar();
    archivos.clear(); jsons.clear();
    if (indice.empty() || maximo == 0) return false;
    archivos.push_back(indice.back());
    for (size_t i = 0; archivos.size() < maximo && i + 1 < indice.size(); ++i)
      archivos.push_back(indice[i]);
    jsons.resize(archivos.size());
    for (size_t i = 0; i < archivos.size(); ++i)
      if (!disco.leer("/pendientes/" + archivos[i], jsons[i])) return false;
    return true;
  }
  bool confirmar(const std::string &archivo) {
    cargar();
    if (!esLog(archivo) || !std::binary_search(indice.begin(), indice.end(), archivo)) return false;
    // Si el reinicio ocurrió antes del rename se reintentará el mismo JSON.
    if (!disco.mover("/pendientes/" + archivo, "/enviados/" + archivo)) return false;
    indice.erase(std::lower_bound(indice.begin(), indice.end(), archivo));
    enviados.insert(std::lower_bound(enviados.begin(), enviados.end(), archivo), archivo);
    limpiar();
    return true;
  }
  bool limpiar() {
    cargar();
    while (enviados.size() > retenidos) {
      if (!disco.borrar("/enviados/" + enviados.front())) return false;
      enviados.erase(enviados.begin());
    }
    return true;
  }
};

inline uint32_t demora(unsigned fallos) {
  return 1000U << std::min(fallos, 5U); // 1, 2, 4, 8, 16, 32 s
}
} // namespace registro
