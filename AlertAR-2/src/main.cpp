#include <Arduino.h>
#include <Wire.h>
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
// #include "conectividad.h"

alertar::Agua agua;

alertar::Carril carril1;
alertar::Carril carril2;

// ============================================================
// ULTRASONIDO
// ============================================================

float leerDistanciaCm(int trig, int echo) {

  // Asegurar pulso limpio
  digitalWrite(trig, LOW);
  delayMicroseconds(2);

  // Disparo ultrasónico
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);

  // Esperar eco.
  // Timeout de 30 ms para evitar bloquear demasiado el ESP32.
  const unsigned long duracion =
      pulseIn(echo, HIGH, 30000UL);

  // Si no llegó ningún eco
  if (duracion == 0) {
    return -1.0f;
  }

  // Velocidad del sonido ≈ 343 m/s
  float distancia =
      duracion * 0.0343f / 2.0f;

  // Wokwi puede quedar apenas por encima de 400 cm
  // cuando el slider está completamente al máximo.
  if (distancia > 400.0f &&
      distancia <= 410.0f) {

    distancia = 400.0f;
  }

  return distancia;
}

// ============================================================
// LCD
// ============================================================

void mostrarLCD(
    const char *linea1,
    const char *linea2
) {

  static String anterior1 = "";
  static String anterior2 = "";

  // No redibujar si no cambió nada.
  // Esto evita parpadeos y operaciones I2C innecesarias.
  if (
      anterior1 == linea1 &&
      anterior2 == linea2
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
  static String ultimoCodigo = "";
  static String ultimoDiagnostico = "";

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

      ultimoCodigo != estado.codigo ||

      ultimoDiagnostico != estado.diagnostico ||

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

  // ==========================================================
  // ULTRASONIDO 1
  // ==========================================================

  pinMode(TRIG1, OUTPUT);
  pinMode(ECHO1, INPUT);

  // ==========================================================
  // ULTRASONIDO 2
  // ==========================================================

  pinMode(TRIG2, OUTPUT);
  pinMode(ECHO2, INPUT);

  // Mantener TRIG en LOW inicialmente
  digitalWrite(TRIG1, LOW);
  digitalWrite(TRIG2, LOW);

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

  // conectividad::iniciar();
}

// ============================================================
// LOOP
// ============================================================

void loop() {

  // conectividad::comandos();

  // Tiempo de referencia para esta iteración.
  const uint32_t ahora =
      millis();

  // ----------------------------------------------------------
  // Delay temporal para pruebas de rendimiento en Wokwi
  // ----------------------------------------------------------

  delay(50);

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
      leerDistanciaCm(
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
      leerDistanciaCm(
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

  // conectividad::observar(
  //     estado,
  //     carril1,
  //     carril2,
  //     agua
  // );

  // conectividad::informar();

  // ==========================================================
  // FIN DEL CICLO
  // ==========================================================

  delay(200);
}