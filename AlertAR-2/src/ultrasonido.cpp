#include "ultrasonido.h"
#include <Arduino.h>
#include <driver/gpio.h>
#include <esp_timer.h>
#include <soc/gpio_struct.h>

namespace ultrasonido {
namespace {
struct Sensor {
  int trig = -1, echo = -1;
  SemaphoreHandle_t completo = nullptr;
  portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
  volatile bool esperando = false, subio = false;
  volatile uint32_t inicio = 0, duracion = 0;
} sensores[2];
uint32_t fallosLectura = 0;

// Toda la ISR se ejecuta en RAM, incluso mientras se escribe flash.
void IRAM_ATTR flanco(void *arg) {
  auto &s = *static_cast<Sensor *>(arg);
  const uint32_t ahora = static_cast<uint32_t>(esp_timer_get_time());
  const bool alto = (GPIO.in >> s.echo) & 1U; // Ambos ECHO están en GPIO < 32.
  bool despertar = false;
  portENTER_CRITICAL_ISR(&s.mux);
  if (s.esperando) {
    if (alto && !s.subio) { s.inicio = ahora; s.subio = true; }
    else if (!alto && s.subio) {
      s.duracion = ahora - s.inicio;
      s.esperando = false;
      despertar = true;
    }
  }
  portEXIT_CRITICAL_ISR(&s.mux);
  if (despertar) {
    BaseType_t prioridad = pdFALSE;
    xSemaphoreGiveFromISR(s.completo, &prioridad);
    if (prioridad) portYIELD_FROM_ISR();
  }
}
}

bool iniciar(int trig1, int echo1, int trig2, int echo2) {
  if (echo1 < 0 || echo1 >= 32 || echo2 < 0 || echo2 >= 32) return false;
  if (gpio_install_isr_service(ESP_INTR_FLAG_IRAM) != ESP_OK) return false;
  const int trigs[] = {trig1, trig2}, echoes[] = {echo1, echo2};
  for (int i = 0; i < 2; ++i) {
    auto &s = sensores[i];
    s.trig = trigs[i]; s.echo = echoes[i];
    s.completo = xSemaphoreCreateBinary();
    if (!s.completo) return false;
    pinMode(s.trig, OUTPUT); digitalWrite(s.trig, LOW);
    pinMode(s.echo, INPUT);
    if (gpio_set_intr_type(static_cast<gpio_num_t>(s.echo), GPIO_INTR_ANYEDGE) != ESP_OK ||
        gpio_isr_handler_add(static_cast<gpio_num_t>(s.echo), flanco, &s) != ESP_OK) return false;
  }
  return true;
}

float leer(int trig, int echo) {
  Sensor *sensor = nullptr;
  for (auto &s : sensores) if (s.trig == trig && s.echo == echo) sensor = &s;
  if (!sensor || !sensor->completo) { ++fallosLectura; return -1; }
  auto &s = *sensor;
  xSemaphoreTake(s.completo, 0); // Descartar notificación vieja después de un timeout.
  portENTER_CRITICAL(&s.mux);
  s.subio = false; s.duracion = 0; s.esperando = true;
  portEXIT_CRITICAL(&s.mux);
  digitalWrite(trig, LOW); delayMicroseconds(2);
  digitalWrite(trig, HIGH); delayMicroseconds(10); digitalWrite(trig, LOW);
  // Bloquea esta tarea, no ejecuta un bucle de espera activa como pulseIn.
  xSemaphoreTake(s.completo, pdMS_TO_TICKS(30));
  portENTER_CRITICAL(&s.mux);
  const uint32_t duracion = s.duracion;
  s.esperando = false;
  portEXIT_CRITICAL(&s.mux);
  if (duracion == 0 || duracion > 30000) { ++fallosLectura; return -1; }
  float distancia = duracion * 0.0343f / 2.0f;
  if (distancia > 400 && distancia <= 410) distancia = 400;
  if (distancia < 2 || distancia > 400) ++fallosLectura;
  return distancia;
}
uint32_t fallos() { return fallosLectura; }
}
