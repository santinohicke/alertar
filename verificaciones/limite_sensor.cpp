// Diagnóstico de la diferencia preexistente entre firmware y tests/logica_test.cpp.
#include "../AlertAR-2/src/logica.h"
#include <iostream>
int main() {
  alertar::Agua agua;
  alertar::Carril libre;
  libre.actualizar(400, 0);
  for (float distancia : {400.0f, 400.1f, 410.0f, 410.1f}) {
    alertar::Carril sensor;
    sensor.actualizar(distancia, 0);
    std::cout << distancia << " cm: valido=" << sensor.valido
              << ", codigo=" << alertar::decidir(sensor, libre, agua).codigo << '\n';
  }
}
