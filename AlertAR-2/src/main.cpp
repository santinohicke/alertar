#include <Arduino.h>
#include <Wire.h>
#include <string.h>
#include <LiquidCrystal_I2C.h>

// ============================================================
// PINES
// ============================================================

// ---------- Ultrasonido carril 1 ----------
#define TRIG1 26
#define ECHO1 25

// ---------- Ultrasonido carril 2 ----------
#define TRIG2 19
#define ECHO2 21

// ---------- Sensor de agua ----------
#define PIN_AGUA 34

// ---------- LEDs ----------
#define LED_VERDE 17
#define LED_AMARILLO 5
#define LED_ROJO 18

// ---------- I2C ----------
#define SDA_PIN 32
#define SCL_PIN 33

// ============================================================
// CONFIGURACIÓN
// ============================================================

// Tiempo antes de empezar a reportar fallas
constexpr unsigned long TIEMPO_INICIALIZACION_MS = 2000;

// Enviar telemetría aunque no haya cambios cada 5 segundos
constexpr unsigned long INTERVALO_TELEMETRIA_MS = 5000;

// ============================================================
// LCD
// ============================================================

LiquidCrystal_I2C lcd(0x27, 16, 2);

// ============================================================
// LÓGICA DEL SISTEMA
// ============================================================

#include "logica.h"
#include "conectividad.h"
#include "conectividad_config.h"
#include "ultrasonido.h"

alertar::Agua agua;

alertar::Carril carril1;
alertar::Carril carril2;

// ============================================================
// LCD
// ============================================================

void mostrarLCD(
    const char *linea1,
    const char *linea2
) {

  // Los textos son literales del firmware: guardar el puntero alcanza
  // y evita copias en el heap en cada ciclo.
  static const char *anterior1 = nullptr;
  static const char *anterior2 = nullptr;

  // No redibujar si no cambió nada.
  // Esto evita parpadeos y operaciones I2C innecesarias.
  if (
      anterior1 && anterior2 &&
      strcmp(anterior1, linea1) == 0 &&
      strcmp(anterior2, linea2) == 0
  ) {
    return;
  }

  anterior1 = linea1;
  anterior2 = linea2;

  lcd.clear();

  lcd.setCursor(0, 0);
  lcd.print(linea1);

  lcd.setCursor(0, 1);
  lcd.print(linea2);
}

// ============================================================
// TELEMETRÍA
// ============================================================

void imprimirAltura(
    const alertar::Carril &carril
) {

  if (carril.valido) {
    Serial.print(carril.altura);
  } else {
    Serial.print("null");
  }
}

// ------------------------------------------------------------
// Enviar JSON completo
// ------------------------------------------------------------

void enviarJSON(
    const alertar::Estado &estado
) {

  // IMPORTANTE:
  // Una sola línea JSON por mensaje.
  //
  // No imprimir mensajes adicionales por Serial si existe
  // un programa externo leyendo esta telemetría.

  Serial.print("{\"codigo\":\"");
  Serial.print(estado.codigo);

  Serial.print("\",\"diagnostico\":\"");
  Serial.print(estado.diagnostico);

  Serial.print("\",\"obstruccion_carril1_cm\":");
  imprimirAltura(carril1);

  Serial.print(",\"obstruccion_carril2_cm\":");
  imprimirAltura(carril2);

  Serial.print(",\"sensor1_valido\":");
  Serial.print(
      carril1.valido
          ? "true"
          : "false"
  );

  Serial.print(",\"sensor2_valido\":");
  Serial.print(
      carril2.valido
          ? "true"
          : "false"
  );

  Serial.print(",\"agua_activa\":");
  Serial.print(
      agua.confirmada
          ? "true"
          : "false"
  );

  Serial.print(",\"agua_pendiente\":");
  Serial.print(
      agua.pendiente()
          ? "true"
          : "false"
  );

  Serial.println("}");
}

// ------------------------------------------------------------
// Decidir si corresponde enviar JSON
// ------------------------------------------------------------

void enviarJSONSiCorresponde(
    const alertar::Estado &estado
) {

  // Último momento en el que enviamos telemetría
  static unsigned long ultimoEnvio = 0;

  // Estado anterior enviado
  // Literales de alertar::decidir(): se comparan con strcmp, sin copiar.
  static const char *ultimoCodigo = "";
  static const char *ultimoDiagnostico = "";

  static int ultimoColor = -1;

  static bool ultimaAguaConfirmada = false;
  static bool ultimaAguaPendiente = false;

  static bool ultimoSensor1Valido = false;
  static bool ultimoSensor2Valido = false;

  // Sirve para que el primer estado válido
  // siempre sea enviado inmediatamente.
  static bool primerEnvio = true;

  const unsigned long ahora = millis();

  const bool aguaPendienteActual =
      agua.pendiente();

  // ----------------------------------------------------------
  // Detectar cambios importantes
  // ----------------------------------------------------------

  const bool huboCambio =
      primerEnvio ||

      strcmp(ultimoCodigo, estado.codigo) != 0 ||

      strcmp(ultimoDiagnostico, estado.diagnostico) != 0 ||

      ultimoColor != (int)estado.color ||

      ultimaAguaConfirmada != agua.confirmada ||

      ultimaAguaPendiente != aguaPendienteActual ||

      ultimoSensor1Valido != carril1.valido ||

      ultimoSensor2Valido != carril2.valido;

  // ----------------------------------------------------------
  // Enviar actualización periódica cada 5 segundos
  // ----------------------------------------------------------

  const bool pasoIntervalo =
      ahora - ultimoEnvio >=
      INTERVALO_TELEMETRIA_MS;

  // Si no cambió nada y todavía no pasaron 5 segundos,
  // no hacemos nada.
  if (
      !huboCambio &&
      !pasoIntervalo
  ) {
    return;
  }

  // ----------------------------------------------------------
  // Enviar
  // ----------------------------------------------------------

  enviarJSON(estado);

  // ----------------------------------------------------------
  // Guardar estado actual
  // ----------------------------------------------------------

  ultimoCodigo =
      estado.codigo;

  ultimoDiagnostico =
      estado.diagnostico;

  ultimoColor =
      (int)estado.color;

  ultimaAguaConfirmada =
      agua.confirmada;

  ultimaAguaPendiente =
      aguaPendienteActual;

  ultimoSensor1Valido =
      carril1.valido;

  ultimoSensor2Valido =
      carril2.valido;

  ultimoEnvio =
      ahora;

  primerEnvio =
      false;
}

// ============================================================
// SETUP
// ============================================================

void setup() {

  Serial.begin(115200);

  // Los pines de los ultrasonidos los configura ultrasonido::iniciar().

  // ==========================================================
  // SENSOR DE AGUA
  // ==========================================================

  pinMode(PIN_AGUA, INPUT);

  // ==========================================================
  // LEDs
  // ==========================================================

  pinMode(LED_VERDE, OUTPUT);
  pinMode(LED_AMARILLO, OUTPUT);
  pinMode(LED_ROJO, OUTPUT);

  // Durante inicialización:
  //
  // VERDE     apagado
  // AMARILLO  encendido
  // ROJO      apagado

  digitalWrite(
      LED_VERDE,
      LOW
  );

  digitalWrite(
      LED_AMARILLO,
      HIGH
  );

  digitalWrite(
      LED_ROJO,
      LOW
  );

  // ==========================================================
  // LCD
  // ==========================================================

  Wire.begin(
      SDA_PIN,
      SCL_PIN
  );

  lcd.init();
  lcd.backlight();

  mostrarLCD(
      "PRECAUCION",
      "Iniciando..."
  );

  // Si falla, las lecturas dan -1 y el sistema queda en ERR-003 (falla de sensor);
  // esta línea deja asentado el motivo en el Serial.
  if (!ultrasonido::iniciar(TRIG1, ECHO1, TRIG2, ECHO2)) {
    Serial.println("{\"tipo\":\"error\",\"detalle\":\"no se pudieron iniciar los ultrasonidos\"}");
  }
  if (conexion_config::HABILITADA) conectividad::iniciar();
}

// ============================================================
// LOOP
// ============================================================

void loop() {

  if (conexion_config::HABILITADA) conectividad::comandos();

  // Tiempo de referencia para esta iteración.
  const uint32_t ahora =
      millis();

  // ==========================================================
  // SENSOR DE AGUA
  // ==========================================================

  const int lecturaAgua =
      analogRead(PIN_AGUA);

  agua.actualizar(
      lecturaAgua,
      ahora
  );

  // ==========================================================
  // ULTRASONIDO CARRIL 1
  // ==========================================================

  const float distancia1 =
      ultrasonido::leer(
          TRIG1,
          ECHO1
      );

  carril1.actualizar(
      distancia1,
      millis()
  );

  // Separar disparos de ambos sensores para evitar
  // interferencia entre ecos.
  delay(60);

  // ==========================================================
  // ULTRASONIDO CARRIL 2
  // ==========================================================

  const float distancia2 =
      ultrasonido::leer(
          TRIG2,
          ECHO2
      );

  carril2.actualizar(
      distancia2,
      millis()
  );

  // ==========================================================
  // PERÍODO DE INICIALIZACIÓN
  // ==========================================================

  if (
      millis() <
      TIEMPO_INICIALIZACION_MS
  ) {

    digitalWrite(
        LED_VERDE,
        LOW
    );

    digitalWrite(
        LED_AMARILLO,
        HIGH
    );

    digitalWrite(
        LED_ROJO,
        LOW
    );

    mostrarLCD(
        "PRECAUCION",
        "Iniciando..."
    );

    delay(200);

    return;
  }

  // ==========================================================
  // DECISIÓN DEL SISTEMA
  // ==========================================================

  const alertar::Estado estado =
      alertar::decidir(
          carril1,
          carril2,
          agua
      );

  // ==========================================================
  // LEDs
  // ==========================================================

  digitalWrite(
      LED_VERDE,
      estado.color ==
          alertar::VERDE
  );

  digitalWrite(
      LED_AMARILLO,
      estado.color ==
          alertar::AMARILLO
  );

  digitalWrite(
      LED_ROJO,
      estado.color ==
          alertar::ROJO
  );

  // ==========================================================
  // LCD
  // ==========================================================

  mostrarLCD(
      estado.linea1,
      estado.linea2
  );

  // ==========================================================
  // TELEMETRÍA
  // ==========================================================

  // Envía solamente:
  //
  // 1. Cuando cambia el estado.
  // 2. Cuando cambia agua.
  // 3. Cuando cambia la validez de un sensor.
  // 4. Cada 5 segundos aunque no haya cambios.
  //
  // Las pequeñas variaciones en centímetros NO provocan
  // envíos adicionales.

  enviarJSONSiCorresponde(
      estado
  );

  // ==========================================================
  // CONECTIVIDAD
  // ==========================================================

  if (conexion_config::HABILITADA) {
    conectividad::observar(estado, carril1, carril2, agua);
    conectividad::informar();
  }

  // ==========================================================
  // FIN DEL CICLO
  // ==========================================================

  delay(200);
}
