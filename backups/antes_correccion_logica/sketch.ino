#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ---------- Pines ----------
#define TRIG1 26
#define ECHO1 25
#define TRIG2 19
#define ECHO2 21
#define PIN_AGUA 34   // potenciometro simula sensor de agua
#define LED_VERDE 17
#define LED_AMARILLO 5
#define LED_ROJO 18
#define SDA_PIN 32
#define SCL_PIN 33

LiquidCrystal_I2C lcd(0x27, 16, 2); // si no muestra nada, probar 0x3F

// ---------- Parametros del sistema ----------
const float ALTURA_MONTAJE = 150.0;
const float UMBRAL_ALTA = 100.0;
const int UMBRAL_AGUA = 2000;
const unsigned long ANTIRREBOTE_MS = 20000;

unsigned long tAguaActiva = 0;
bool aguaConfirmada = false;

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

void mostrarLCD(String linea1, String linea2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(linea1);
  lcd.setCursor(0, 1);
  lcd.print(linea2);
}

void enviarJSON(String diagnostico, float alt1, float alt2, bool agua) {
  Serial.print("{\"diagnostico\":\"");
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

  int lecturaAgua = analogRead(PIN_AGUA);
  bool aguaBruta = lecturaAgua > UMBRAL_AGUA;

  if (aguaBruta) {
    if (tAguaActiva == 0) tAguaActiva = millis();
    aguaConfirmada = (millis() - tAguaActiva) >= ANTIRREBOTE_MS;
  } else {
    tAguaActiva = 0;
    aguaConfirmada = false;
  }

  bool sinLectura = (d1 < 0 && d2 < 0);
  bool obst1 = (d1 >= 0 && alt1 > 5);
  bool obst2 = (d2 >= 0 && alt2 > 5);

  String diagnostico;

  if (sinLectura) {
    diagnostico = "Falla de sensor";
    setLeds(false, true, false);
    mostrarLCD("PRECAUCION", "Falla sensor");
  } else if (obst1 && obst2 && aguaConfirmada) {
    diagnostico = "Inundacion";
    setLeds(false, false, true);
    mostrarLCD("PASO CERRADO", "Inundacion");
  } else if (obst1 && obst2 && alt1 > UMBRAL_ALTA && alt2 > UMBRAL_ALTA) {
    diagnostico = "Transito detenido";
    setLeds(false, false, true);
    mostrarLCD("TRANSITO", "DETENIDO");
  } else if (obst1 != obst2) {
    diagnostico = "Carril bloqueado";
    setLeds(false, true, false);
    mostrarLCD("PRECAUCION", "Carril bloqueado");
  } else if (!obst1 && !obst2) {
    diagnostico = "Situacion normal";
    setLeds(true, false, false);
    mostrarLCD("Paso habilitado", "Sin alerta");
  } else {
    diagnostico = "Precaucion";
    setLeds(false, true, false);
    mostrarLCD("PRECAUCION", "Verificar paso");
  }

  enviarJSON(diagnostico, alt1, alt2, aguaConfirmada);
  delay(1000);
}