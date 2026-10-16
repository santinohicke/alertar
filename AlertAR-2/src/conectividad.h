#pragma once
#include "logica.h"

namespace conectividad {
void iniciar();
// No realiza I/O de red/flash ni espera mutex: copia a la cola con timeout cero.
void observar(const alertar::Estado &, const alertar::Carril &, const alertar::Carril &,
              const alertar::Agua &);
// JSON de diagnóstico separado, imprimido exclusivamente desde el loop.
void informar();
// Controles de ensayo por serie: '0' corta Wi-Fi, '1' reconecta, 'r' reinicia.
void comandos();
}
