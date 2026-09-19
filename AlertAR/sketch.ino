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

#include "logica.h"

alertar::Agua agua;
alertar::Carril carril1, carril2;

float leerDistanciaCm(int trig, int echo) {
  digitalWrite(trig, LOW);
  delayMicroseconds(2);
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);
  const unsigned long duracion = pulseIn(echo, HIGH, 30000);
  return duracion == 0 ? -1.0f : duracion / 58.0f;
}

void mostrarLCD(const char *linea1, const char *linea2) {
  static String anterior1, anterior2;
  if (anterior1 == linea1 && anterior2 == linea2) return;
  anterior1 = linea1; anterior2 = linea2;
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(linea1);
  lcd.setCursor(0, 1); lcd.print(linea2);
}

void imprimirAltura(const alertar::Carril &carril) {
  if (carril.valido) Serial.print(carril.altura);
  else Serial.print("null");
}

void enviarJSON(const alertar::Estado &estado) {
  // Una línea JSON por muestra; sin texto extra que rompa el lector de telemetría.
  Serial.print("{\"codigo\":\""); Serial.print(estado.codigo);
  Serial.print("\",\"diagnostico\":\""); Serial.print(estado.diagnostico);
  Serial.print("\",\"obstruccion_carril1_cm\":"); imprimirAltura(carril1);
  Serial.print(",\"obstruccion_carril2_cm\":"); imprimirAltura(carril2);
  Serial.print(",\"sensor1_valido\":"); Serial.print(carril1.valido ? "true" : "false");
  Serial.print(",\"sensor2_valido\":"); Serial.print(carril2.valido ? "true" : "false");
  Serial.print(",\"agua_activa\":"); Serial.print(agua.confirmada ? "true" : "false");
  Serial.print(",\"agua_pendiente\":"); Serial.print(agua.pendiente() ? "true" : "false");
  Serial.println("}");
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG1, OUTPUT); pinMode(ECHO1, INPUT);
  pinMode(TRIG2, OUTPUT); pinMode(ECHO2, INPUT);
  pinMode(PIN_AGUA, INPUT);
  pinMode(LED_VERDE, OUTPUT); pinMode(LED_AMARILLO, OUTPUT); pinMode(LED_ROJO, OUTPUT);
  digitalWrite(LED_VERDE, LOW); digitalWrite(LED_AMARILLO, HIGH); digitalWrite(LED_ROJO, LOW);
  Wire.begin(SDA_PIN, SCL_PIN);
  lcd.init(); lcd.backlight();
  mostrarLCD("PRECAUCION", "Iniciando...");
}

void loop() {
  agua.actualizar(analogRead(PIN_AGUA), millis());
  carril1.actualizar(leerDistanciaCm(TRIG1, ECHO1), millis());
  // Separar los disparos para reducir ecos cruzados entre los dos sensores.
  delay(60);
  carril2.actualizar(leerDistanciaCm(TRIG2, ECHO2), millis());
  const alertar::Estado estado = alertar::decidir(carril1, carril2, agua);
  digitalWrite(LED_VERDE, estado.color == alertar::VERDE);
  digitalWrite(LED_AMARILLO, estado.color == alertar::AMARILLO);
  digitalWrite(LED_ROJO, estado.color == alertar::ROJO);
  mostrarLCD(estado.linea1, estado.linea2);
  enviarJSON(estado);
  delay(200); // Ciclo local aproximado: 260–320 ms, según los ecos.
}
