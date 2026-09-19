#pragma once
#include <stdint.h>
#include <math.h>

namespace alertar {
constexpr float DISTANCIA_MINIMA = 2.0f;
constexpr float DISTANCIA_MAXIMA = 400.0f;
// Altura techo-calzada de la simulación. En instalación real debe medirse.
constexpr float ALTURA_MONTAJE = 400.0f;
static_assert(ALTURA_MONTAJE <= DISTANCIA_MAXIMA, "El sensor no alcanza el suelo");
constexpr float UMBRAL_OBSTRUCCION = 5.0f;
constexpr float UMBRAL_ALTA = 100.0f;
constexpr int AGUA_ON = 2000, AGUA_OFF = 1800;
constexpr uint32_t CONFIRMAR_AGUA_MS = 20000, SECADO_MS = 20000;
constexpr uint32_t PERSISTENCIA_MS = 60000, LIBERAR_CARRIL_MS = 3000;

struct Agua {
  bool bruta = false, confirmada = false, contando = false;
  uint32_t inicio = 0;
  void actualizar(int adc, uint32_t ahora) {
    if (adc > AGUA_ON) bruta = true;
    else if (adc <= AGUA_OFF) bruta = false;
    if (bruta == confirmada) { contando = false; return; }
    if (!contando) { contando = true; inicio = ahora; }
    if (uint32_t(ahora - inicio) >= (bruta ? CONFIRMAR_AGUA_MS : SECADO_MS)) {
      confirmada = bruta;
      contando = false;
    }
  }
  bool pendiente() const { return bruta && !confirmada; }
};

struct Carril {
  bool valido = false, ocupado = false, alto = false;
  bool liberando = false, anteriorValido = false;
  float altura = 0;
  uint32_t ocupacionMs = 0, altaMs = 0, ultimo = 0, inicioLibre = 0;
  static uint32_t sumar(uint32_t a, uint32_t b) {
    return b >= PERSISTENCIA_MS - a ? PERSISTENCIA_MS : a + b;
  }
  void actualizar(float distancia, uint32_t ahora) {
    valido = isfinite(distancia) && distancia >= DISTANCIA_MINIMA && distancia <= DISTANCIA_MAXIMA;
    const uint32_t dt = uint32_t(ahora - ultimo);
    ultimo = ahora;
    if (!valido) {
      anteriorValido = false;
      liberando = false;
      return; // Conservar estado, pero no contar tiempo sin observaciones válidas.
    }
    altura = ALTURA_MONTAJE - distancia;
    if (altura < 0) altura = 0;
    if (altura > UMBRAL_OBSTRUCCION) {
      const bool nuevaAlta = altura > UMBRAL_ALTA;
      if (ocupado && anteriorValido && !liberando) {
        ocupacionMs = sumar(ocupacionMs, dt);
        altaMs = alto && nuevaAlta ? sumar(altaMs, dt) : 0;
      } else if (!ocupado) {
        ocupacionMs = altaMs = 0;
      } else if (!alto || !nuevaAlta) {
        altaMs = 0;
      }
      ocupado = true;
      alto = nuevaAlta;
      liberando = false;
    } else if (ocupado) {
      // No sumar vehículos sucesivos como una única obstrucción persistente.
      // Solo las alertas ya confirmadas conservan el estado durante la liberación.
      if (!persistente()) {
        ocupado = alto = liberando = false;
        ocupacionMs = altaMs = 0;
        anteriorValido = true;
        return;
      }
      if (!liberando) { liberando = true; inicioLibre = ahora; }
      if (uint32_t(ahora - inicioLibre) >= LIBERAR_CARRIL_MS) {
        ocupado = alto = liberando = false;
        ocupacionMs = altaMs = 0;
      }
    }
    anteriorValido = true;
  }
  bool persistente() const { return ocupado && ocupacionMs >= PERSISTENCIA_MS; }
  bool altaPersistente() const { return ocupado && alto && altaMs >= PERSISTENCIA_MS; }
};

enum Color { VERDE, AMARILLO, ROJO };
struct Estado { const char *codigo, *diagnostico, *linea1, *linea2; Color color; };

// Orden de prioridad idéntico al de tabla_logica.md. Siempre retorna un estado.
inline Estado decidir(const Carril &a, const Carril &b, const Agua &agua) {
  if (agua.confirmada)
    return {"ERR-001", "Agua critica confirmada", "PASO CERRADO", "Agua critica", ROJO};
  if (!a.valido || !b.valido)
    return {"ERR-003", "Lectura ultrasonica invalida", "PRECAUCION", "Falla de sensor", AMARILLO};
  if (a.persistente() && b.persistente())
    return {"ERR-005", "Bloqueo persistente en ambos carriles", "PASO CERRADO", "Ambos bloqueados", ROJO};
  if (agua.pendiente())
    return {"ERR-002", "Agua pendiente de confirmacion", "PRECAUCION", "Verificando agua", AMARILLO};
  const bool ambos = a.ocupado && b.ocupado;
  const bool uno = a.ocupado != b.ocupado;
  const bool transito = (a.ocupado || b.ocupado)
      && !a.persistente() && !b.persistente();
  if (ambos && (a.persistente() || b.persistente()))
    return {"ERR-004", "Obstruccion en ambos carriles", "PRECAUCION", "Obstruccion", AMARILLO};
  if (uno && (a.altaPersistente() || b.altaPersistente()))
    return {"ERR-006", "Obstruccion alta persistente en un carril", "PRECAUCION", "Carril bloqueado", AMARILLO};
  // Incluye una ocupación persistente que acaba de cambiar de baja/media a alta.
  if (uno && (a.persistente() || b.persistente()))
    return {"ERR-007", "Obstruccion en un carril", "PRECAUCION", "Obstruccion", AMARILLO};
  if (transito)
    return {"INF-001", "Ocupacion transitoria", "Paso habilitado", "Transitorio", VERDE};
  if (!a.ocupado && !b.ocupado)
    return {"OK-001", "Situacion normal", "Paso habilitado", "", VERDE};
  return {"ERR-002", "Situacion no clasificada", "PRECAUCION", "Verificar paso", AMARILLO};
}
} // namespace alertar
