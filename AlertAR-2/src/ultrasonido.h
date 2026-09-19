#pragma once
#include <stdint.h>

namespace ultrasonido {
bool iniciar(int trig1, int echo1, int trig2, int echo2);
float leer(int trig, int echo);
uint32_t fallos();
}
