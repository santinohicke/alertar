#include "../AlertAR-2/src/registro.h"
#include <cassert>
#include <iostream>
#include <map>

struct Memoria : registro::Disco {
  std::map<std::string, std::string> files;
  bool falloEscritura = false, falloRename = false;
  unsigned listados = 0, lecturas = 0;
  std::vector<std::string> listar(const std::string &dir) override {
    ++listados;
    std::vector<std::string> result;
    for (const auto &entry : files)
      if (entry.first.find(dir + "/") == 0) result.push_back(entry.first.substr(dir.size()+1));
    return result;
  }
  bool leer(const std::string &path, std::string &out) override {
    ++lecturas;
    auto it = files.find(path);
    if (it == files.end()) return false;
    out = it->second; return true;
  }
  bool escribir(const std::string &path, const std::string &value) override {
    files[path] = falloEscritura ? value.substr(0, value.size()/2) : value;
    return !falloEscritura;
  }
  bool mover(const std::string &a, const std::string &b) override {
    if (falloRename || !files.count(a) || files.count(b)) return false;
    files[b] = files[a]; files.erase(a); return true;
  }
  bool borrar(const std::string &path) override { return files.erase(path); }
};

int main() {
  using R = registro::Cola::Resultado;
  Memoria disk;
  registro::Cola queue(disk, 2, 1);
  std::string name, payload;
  for (unsigned i=0; i<1000; ++i) {
    assert(queue.pendientes() == 0);
    assert(!queue.primero(name, payload));
  }
  assert(disk.listados == 2 && disk.lecturas == 0); // Cero acceso a flash en reposo.
  assert(queue.guardar(10, "{\"secuencia\":10}") == R::OK);
  assert(queue.guardar(2, "{\"secuencia\":2}") == R::OK);
  assert(disk.listados == 2); // Guardar tampoco recorre directorios.
  assert(queue.guardar(3, "nuevo") == R::LLENO);
  assert(queue.primero(name, payload) && name == registro::nombre(2));
  assert(queue.guardar(2, payload) == R::OK);
  assert(queue.guardar(2, "diferente") == R::ERROR);
  // Sin ACK no se elimina nada. Reiniciar conserva orden y contenido.
  registro::Cola reboot(disk, 2, 1);
  assert(reboot.pendientes() == 2);
  assert(reboot.primero(name, payload) && payload == "{\"secuencia\":2}");
  disk.falloRename = true;
  assert(!reboot.confirmar(name) && reboot.pendientes() == 2);
  disk.falloRename = false;
  assert(reboot.confirmar(name) && reboot.pendientes() == 1);
  assert(reboot.primero(name, payload) && name == registro::nombre(10));
  assert(reboot.confirmar(name));
  assert(disk.listar("/enviados").size() == 1); // Retención acotada.
  assert(disk.files.count("/enviados/" + registro::nombre(10)));
  disk.falloEscritura = true;
  assert(reboot.guardar(11, "registro completo") == R::ERROR);
  assert(reboot.pendientes() == 0); // Un temporal incompleto no es enviable.
  disk.falloEscritura = false;
  disk.falloRename = true;
  assert(reboot.guardar(11, "registro completo") == R::ERROR);
  assert(reboot.pendientes() == 0);
  disk.falloRename = false;
  assert(reboot.guardar(11, "registro completo") == R::OK);
  assert(reboot.primero(name, payload) && payload == "registro completo");
  assert(!reboot.confirmar("../../algo"));
  assert(!registro::esLog("abc.log"));
  assert(registro::demora(0) == 1000 && registro::demora(9) == 32000);

  // Lotes: el más nuevo va primero y después el historial en orden.
  Memoria disco2;
  registro::Cola cola(disco2, 32, 4);
  std::vector<std::string> archivos, jsons;
  assert(!cola.lote(9, archivos, jsons) && archivos.empty());
  assert(cola.guardar(5, "e5") == R::OK);
  assert(cola.lote(9, archivos, jsons) && archivos.size() == 1 && jsons[0] == "e5");
  for (unsigned s = 6; s <= 20; ++s) assert(cola.guardar(s, "e" + std::to_string(s)) == R::OK);
  assert(cola.lote(1, archivos, jsons) && jsons.size() == 1 && jsons[0] == "e20");
  assert(cola.lote(9, archivos, jsons) && jsons.size() == 9);
  assert(jsons[0] == "e20" && jsons[1] == "e5" && jsons[2] == "e6" && jsons[8] == "e12");
  for (const auto &a : archivos) assert(cola.confirmar(a));
  assert(cola.pendientes() == 7);
  assert(cola.lote(9, archivos, jsons) && jsons.size() == 7);
  assert(jsons[0] == "e19" && jsons[1] == "e13" && jsons[6] == "e18");
  // Sin duplicados aunque el lote abarque toda la cola.
  for (size_t i = 0; i < archivos.size(); ++i)
    for (size_t j = i + 1; j < archivos.size(); ++j) assert(archivos[i] != archivos[j]);
  disco2.files.erase("/pendientes/" + registro::nombre(13));
  assert(!cola.lote(9, archivos, jsons)); // Registro ilegible: no enviar un lote parcial.
  std::cout << "OK: registro atomico, orden, reinicio, duplicados, capacidad, retencion, fallos, backoff y lotes\n";
}
