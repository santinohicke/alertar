#pragma once

#include <stdint.h>
#include <math.h>

namespace alertar {


// ============================================================
// CONFIGURACIÓN
// ============================================================

constexpr float DISTANCIA_MINIMA = 2.0f;
// El sensor nominalmente llega a 400 cm.
// Dejamos margen para redondeos/timing de la simulación.
constexpr float DISTANCIA_MAXIMA = 410.0f;

// Altura entre el sensor y la calzada.
// En una instalación real debe medirse.
constexpr float ALTURA_MONTAJE = 400.0f;

static_assert(
    ALTURA_MONTAJE <= DISTANCIA_MAXIMA,
    "El sensor no alcanza el suelo"
);


// Una altura superior a 5 cm se considera ocupación.
constexpr float UMBRAL_OBSTRUCCION = 5.0f;

// Una obstrucción superior a 100 cm se considera alta.
constexpr float UMBRAL_ALTA = 100.0f;


// ---------- Sensor de agua ----------

constexpr int AGUA_ON = 2000;
constexpr int AGUA_OFF = 1800;

constexpr uint32_t CONFIRMAR_AGUA_MS = 20000;
constexpr uint32_t SECADO_MS = 20000;


// ---------- Persistencia de obstrucciones ----------

constexpr uint32_t PERSISTENCIA_MS = 60000;

// Tiempo que debe permanecer libre un carril para considerar
// desaparecida una obstrucción persistente.
constexpr uint32_t LIBERAR_CARRIL_MS = 3000;


// ============================================================
// AGUA
// ============================================================

struct Agua {

  bool bruta = false;
  bool confirmada = false;
  bool contando = false;

  uint32_t inicio = 0;


  void actualizar(
      int adc,
      uint32_t ahora
  ) {

    // Histéresis para evitar oscilaciones alrededor del umbral.
    if (adc > AGUA_ON) {

      bruta = true;

    } else if (adc <= AGUA_OFF) {

      bruta = false;
    }


    // Si el estado medido coincide con el confirmado,
    // no necesitamos temporizador.
    if (bruta == confirmada) {

      contando = false;

      return;
    }


    // Comienza período de confirmación.
    if (!contando) {

      contando = true;
      inicio = ahora;
    }


    const uint32_t tiempo =
        uint32_t(ahora - inicio);


    const uint32_t requerido =
        bruta
            ? CONFIRMAR_AGUA_MS
            : SECADO_MS;


    if (tiempo >= requerido) {

      confirmada = bruta;
      contando = false;
    }
  }


  bool pendiente() const {

    return bruta &&
           !confirmada;
  }
};


// ============================================================
// CARRIL
// ============================================================

struct Carril {

  bool valido = false;

  bool ocupado = false;
  bool alto = false;

  bool liberando = false;

  bool anteriorValido = false;


  float altura = 0;


  uint32_t ocupacionMs = 0;
  uint32_t altaMs = 0;

  uint32_t ultimo = 0;
  uint32_t inicioLibre = 0;


  // ----------------------------------------------------------
  // Suma saturada
  // ----------------------------------------------------------

  static uint32_t sumar(
      uint32_t a,
      uint32_t b
  ) {

    if (b >= PERSISTENCIA_MS - a) {

      return PERSISTENCIA_MS;
    }

    return a + b;
  }


  // ----------------------------------------------------------
  // Actualizar carril
  // ----------------------------------------------------------

  void actualizar(
      float distancia,
      uint32_t ahora
  ) {

    valido =
        isfinite(distancia) &&
        distancia >= DISTANCIA_MINIMA &&
        distancia <= DISTANCIA_MAXIMA;


    const uint32_t dt =
        uint32_t(ahora - ultimo);

    ultimo = ahora;


    // Si el sensor no produjo una lectura válida,
    // conservamos el estado anterior pero NO contamos tiempo.
    if (!valido) {

      anteriorValido = false;
      liberando = false;

      return;
    }


    // Convertir distancia sensor-objeto a altura del objeto.
    altura =
        ALTURA_MONTAJE -
        distancia;


    if (altura < 0) {

      altura = 0;
    }


    // ========================================================
    // HAY OBSTRUCCIÓN
    // ========================================================

    if (altura > UMBRAL_OBSTRUCCION) {

      const bool nuevaAlta =
          altura > UMBRAL_ALTA;


      // Ya estaba ocupado y seguimos teniendo observaciones
      // válidas.
      if (
          ocupado &&
          anteriorValido &&
          !liberando
      ) {

        ocupacionMs =
            sumar(
                ocupacionMs,
                dt
            );


        // La altura tiene que mantenerse continuamente alta
        // para llegar a altaPersistente().
        if (alto && nuevaAlta) {

          altaMs =
              sumar(
                  altaMs,
                  dt
              );

        } else {

          altaMs = 0;
        }


      // Primera detección de una obstrucción.
      } else if (!ocupado) {

        ocupacionMs = 0;
        altaMs = 0;


      // Si estaba en proceso de liberación o cambió la altura,
      // reiniciamos la persistencia de altura alta.
      } else if (!alto || !nuevaAlta) {

        altaMs = 0;
      }


      ocupado = true;

      alto = nuevaAlta;

      liberando = false;
    }


    // ========================================================
    // CARRIL LIBRE
    // ========================================================

    else if (ocupado) {

      // ------------------------------------------------------
      // Una ocupación todavía NO persistente desapareció.
      //
      // Se resetea inmediatamente para evitar sumar distintos
      // vehículos como una sola obstrucción.
      // ------------------------------------------------------

      if (!persistente()) {

        ocupado = false;
        alto = false;
        liberando = false;

        ocupacionMs = 0;
        altaMs = 0;

        anteriorValido = true;

        return;
      }


      // ------------------------------------------------------
      // Si ya era persistente, pedimos algunos segundos libres
      // antes de eliminar el estado.
      // ------------------------------------------------------

      if (!liberando) {

        liberando = true;
        inicioLibre = ahora;
      }


      if (
          uint32_t(
              ahora -
              inicioLibre
          ) >= LIBERAR_CARRIL_MS
      ) {

        ocupado = false;
        alto = false;
        liberando = false;

        ocupacionMs = 0;
        altaMs = 0;
      }
    }


    anteriorValido = true;
  }


  // ----------------------------------------------------------
  // Obstrucción persistente
  // ----------------------------------------------------------

  bool persistente() const {

    return
        ocupado &&
        ocupacionMs >= PERSISTENCIA_MS;
  }


  // ----------------------------------------------------------
  // Obstrucción alta persistente
  // ----------------------------------------------------------

  bool altaPersistente() const {

    return
        ocupado &&
        alto &&
        altaMs >= PERSISTENCIA_MS;
  }
};


// ============================================================
// ESTADOS DEL SISTEMA
// ============================================================

enum Color {

  VERDE,
  AMARILLO,
  ROJO
};


struct Estado {

  const char *codigo;
  const char *diagnostico;

  const char *linea1;
  const char *linea2;

  Color color;
};


// ============================================================
// LÓGICA DE DECISIÓN
// ============================================================

inline Estado decidir(
    const Carril &a,
    const Carril &b,
    const Agua &agua
) {

  // ----------------------------------------------------------
  // 1. Agua confirmada
  // ----------------------------------------------------------

  if (agua.confirmada) {

    return {
        "ERR-001",
        "Agua critica confirmada",
        "PASO CERRADO",
        "Agua critica",
        ROJO
    };
  }


  // ----------------------------------------------------------
  // 2. Sensor ultrasónico inválido
  // ----------------------------------------------------------

  if (!a.valido || !b.valido) {

    return {
        "ERR-003",
        "Lectura ultrasonica invalida",
        "PRECAUCION",
        "Falla de sensor",
        AMARILLO
    };
  }


  // ----------------------------------------------------------
  // 3. Ambos carriles persistentemente bloqueados
  // ----------------------------------------------------------

  if (
      a.persistente() &&
      b.persistente()
  ) {

    return {
        "ERR-005",
        "Bloqueo persistente en ambos carriles",
        "PASO CERRADO",
        "Ambos bloqueados",
        ROJO
    };
  }


  // ----------------------------------------------------------
  // 4. Agua detectada pero todavía no confirmada
  // ----------------------------------------------------------

  if (agua.pendiente()) {

    return {
        "ERR-002",
        "Agua pendiente de confirmacion",
        "PRECAUCION",
        "Verificando agua",
        AMARILLO
    };
  }


  const bool ambos =
      a.ocupado &&
      b.ocupado;


  const bool uno =
      a.ocupado !=
      b.ocupado;


  const bool transito =
      (a.ocupado || b.ocupado) &&
      !a.persistente() &&
      !b.persistente();


  // ----------------------------------------------------------
  // 5. Ambos ocupados y alguno persistente
  // ----------------------------------------------------------

  if (
      ambos &&
      (
          a.persistente() ||
          b.persistente()
      )
  ) {

    return {
        "ERR-004",
        "Obstruccion en ambos carriles",
        "PRECAUCION",
        "Obstruccion",
        AMARILLO
    };
  }


  // ----------------------------------------------------------
  // 6. Un carril con obstrucción alta persistente
  // ----------------------------------------------------------

  if (
      uno &&
      (
          a.altaPersistente() ||
          b.altaPersistente()
      )
  ) {

    return {
        "ERR-006",
        "Obstruccion alta persistente en un carril",
        "PRECAUCION",
        "Carril bloqueado",
        AMARILLO
    };
  }


  // ----------------------------------------------------------
  // 7. Un carril persistentemente bloqueado
  // ----------------------------------------------------------

  if (
      uno &&
      (
          a.persistente() ||
          b.persistente()
      )
  ) {

    return {
        "ERR-007",
        "Obstruccion en un carril",
        "PRECAUCION",
        "Obstruccion",
        AMARILLO
    };
  }


  // ----------------------------------------------------------
  // 8. Ocupación transitoria
  // ----------------------------------------------------------

  if (transito) {

    return {
        "INF-001",
        "Ocupacion transitoria",
        "Paso habilitado",
        "Transitorio",
        VERDE
    };
  }


  // ----------------------------------------------------------
  // 9. Normal
  // ----------------------------------------------------------

  if (
      !a.ocupado &&
      !b.ocupado
  ) {

    return {
        "OK-001",
        "Situacion normal",
        "Paso habilitado",
        "",
        VERDE
    };
  }


  // ----------------------------------------------------------
  // Fallback
  // ----------------------------------------------------------

  return {
      "ERR-002",
      "Situacion no clasificada",
      "PRECAUCION",
      "Verificar paso",
      AMARILLO
  };
}

} // namespace alertar