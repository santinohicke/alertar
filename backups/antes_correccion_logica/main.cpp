#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ---------- Pines ----------
#define TRIG1 26
#define ECHO1 25
#define TRIG2 19
#define ECHO2 21
#define PIN_AGUA 34
#define LED_VERDE 17
#define LED_AMARILLO 5
#define LED_ROJO 18
#define SDA_PIN 32
#define SCL_PIN 33

LiquidCrystal_I2C lcd(0x27, 16, 2);

// ---------- Parametros del sistema ----------
const float ALTURA_MONTAJE = 150.0;
const float UMBRAL_OBSTRUCCION = 5.0;   // cm, a partir de aca se considera que hay algo en el carril
const float UMBRAL_BAJA = 50.0;
const float UMBRAL_ALTA = 100.0;
const int UMBRAL_AGUA = 2000;                  // escala ADC 0-4095
const unsigned long ANTIRREBOTE_AGUA_MS = 20000;
const unsigned long DURACION_TRANSITORIA_MS = 60000;

unsigned long tAguaActiva = 0;
bool aguaConfirmada = false;

unsigned long tObst1 = 0, tObst2 = 0;

float leerDistanciaCm(int trig, int echo) {
  digitalWrite(trig, LOW);
  delayMicroseconds(2);
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);
  long duracion = pulseIn(echo, HIGH, 30000);
  if (duracion == 0) return -1;
  return duracion * 0.0343 / 2.0;
}

void setLeds(bool verde, bool amarillo, bool rojo) {
  digitalWrite(LED_VERDE, verde);
  digitalWrite(LED_AMARILLO, amarillo);
  digitalWrite(LED_ROJO, rojo);
}

void mostrarLCD(String linea1, String linea2 = "") {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(linea1);
  if (linea2.length() > 0) {
    lcd.setCursor(0, 1);
    lcd.print(linea2);
  }
}

void enviarJSON(String codigo, String diagnostico, float alt1, float alt2, bool agua) {
  Serial.print("Codigo: ");
  Serial.print(codigo);
  Serial.print(" | Diagnostico: ");
  Serial.println(diagnostico);

  Serial.print("{\"codigo\":\"");
  Serial.print(codigo);
  Serial.print("\",\"diagnostico\":\"");
  Serial.print(diagnostico);
  Serial.print("\",\"obstruccion_carril1_cm\":");
  Serial.print(alt1);
  Serial.print(",\"obstruccion_carril2_cm\":");
  Serial.print(alt2);
  Serial.print(",\"agua_activa\":");
  Serial.print(agua ? "true" : "false");
  Serial.println("}");
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG1, OUTPUT); pinMode(ECHO1, INPUT);
  pinMode(TRIG2, OUTPUT); pinMode(ECHO2, INPUT);
  pinMode(LED_VERDE, OUTPUT);
  pinMode(LED_AMARILLO, OUTPUT);
  pinMode(LED_ROJO, OUTPUT);

  Wire.begin(SDA_PIN, SCL_PIN);
  lcd.init();
  lcd.backlight();
  mostrarLCD("Iniciando...", "Paso Bajo Nivel");
  delay(1500);
}

void loop() {
  float d1 = leerDistanciaCm(TRIG1, ECHO1);
  float d2 = leerDistanciaCm(TRIG2, ECHO2);
  float alt1 = (d1 < 0) ? -1 : ALTURA_MONTAJE - d1;
  float alt2 = (d2 < 0) ? -1 : ALTURA_MONTAJE - d2;

  // --- Agua, con antirrebote de 20s ---
  int lecturaAgua = analogRead(PIN_AGUA);
  bool aguaBruta = lecturaAgua > UMBRAL_AGUA;
  if (aguaBruta) {
    if (tAguaActiva == 0) tAguaActiva = millis();
    aguaConfirmada = (millis() - tAguaActiva) >= ANTIRREBOTE_AGUA_MS;
  } else {
    tAguaActiva = 0;
    aguaConfirmada = false;
  }

  bool sinLectura = (d1 < 0 && d2 < 0);
  bool obst1 = (d1 >= 0 && alt1 > UMBRAL_OBSTRUCCION);
  bool obst2 = (d2 >= 0 && alt2 > UMBRAL_OBSTRUCCION);

  // --- Duracion de la obstruccion por carril ---
  if (obst1) { if (tObst1 == 0) tObst1 = millis(); } else { tObst1 = 0; }
  if (obst2) { if (tObst2 == 0) tObst2 = millis(); } else { tObst2 = 0; }
  unsigned long dur1 = obst1 ? (millis() - tObst1) : 0;
  unsigned long dur2 = obst2 ? (millis() - tObst2) : 0;
  bool persistente1 = obst1 && dur1 >= DURACION_TRANSITORIA_MS;
  bool persistente2 = obst2 && dur2 >= DURACION_TRANSITORIA_MS;

  bool baja1 = obst1 && alt1 < UMBRAL_BAJA;
  bool baja2 = obst2 && alt2 < UMBRAL_BAJA;
  bool alta1 = obst1 && alt1 > UMBRAL_ALTA;
  bool alta2 = obst2 && alt2 > UMBRAL_ALTA;

  bool ambosObstruidos = obst1 && obst2;
  bool ambosLibres = !obst1 && !obst2;
  bool soloUno = (obst1 != obst2);

  String codigo, diagnostico, l1, l2;

  if (sinLectura) {
    codigo = "ERR-003";
    diagnostico = "Perdida de senal";
    setLeds(false, true, false);
    l1 = "PRECAUCION"; l2 = "Falla de sensor";

  } else if (ambosObstruidos && baja1 && baja2 && aguaConfirmada) {
    codigo = "ERR-001";
    diagnostico = "Inundacion";
    setLeds(false, false, true);
    l1 = "PASO CERRADO"; l2 = "Inundacion";

  } else if (ambosLibres && aguaConfirmada) {
    codigo = "ERR-002";
    diagnostico = "Lectura inconsistente";
    setLeds(false, true, false);
    l1 = "PRECAUCION"; l2 = "Verificar sensor";

  } else if (ambosObstruidos && baja1 && baja2 && persistente1 && persistente2) {
    codigo = "ERR-004";
    diagnostico = "Obstruccion solida";
    setLeds(false, true, false);
    l1 = "PRECAUCION"; l2 = "Obstruccion";

  } else if (ambosObstruidos && alta1 && alta2 && persistente1 && persistente2) {
    codigo = "ERR-005";
    diagnostico = "Transito detenido";
    setLeds(false, false, true);
    l1 = "TRANSITO"; l2 = "DETENIDO";

  } else if (soloUno && ((obst1 && alta1 && persistente1) || (obst2 && alta2 && persistente2))) {
    codigo = "ERR-006";
    diagnostico = "Carril bloqueado";
    setLeds(false, true, false);
    l1 = "PRECAUCION"; l2 = "Carril bloqueado";

  } else if (soloUno && ((obst1 && baja1 && persistente1) || (obst2 && baja2 && persistente2))) {
    codigo = "ERR-007";
    diagnostico = "Acumulacion asimetrica";
    setLeds(false, true, false);
    l1 = "PRECAUCION"; l2 = "Obstruccion";

  } else if (soloUno && ((obst1 && alta1 && !persistente1) || (obst2 && alta2 && !persistente2))) {
    codigo = "INF-001";
    diagnostico = "Vehiculo circulando";
    setLeds(true, false, false);
    l1 = "Paso habilitado"; l2 = "";

  } else if (ambosLibres) {
    codigo = "OK-001";
    diagnostico = "Situacion normal";
    setLeds(true, false, false);
    l1 = "Paso habilitado"; l2 = "";

  }

  mostrarLCD(l1, l2);
  enviarJSON(codigo, diagnostico, alt1, alt2, aguaConfirmada);
  delay(1000);
}
