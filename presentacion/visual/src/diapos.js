// Diapositivas 2D (todo menos el hardware): se agregan a la misma línea de tiempo que el 3D,
// así → y ← funcionan igual en toda la presentación.
import gsap from "gsap";
import { ponerIconos } from "./iconos.js";
import { MAPA } from "./mapa.js";
import { MAPA_GBA, PASOS_GBA } from "./mapa_gba.js";

const $ = s => document.querySelector(s);
const pesos = v => "$" + Math.round(v).toLocaleString("es-AR");
const entero = v => Math.round(v).toLocaleString("es-AR");
const COLOR = { ok: "#2eb872", warn: "#e9a92b", crit: "#ef4f4f" }; // los mismos del panel

// El lienzo 2D mide 1600 × 900 y se escala para entrar en la pantalla.
function ajustar() {
  document.documentElement.style.setProperty("--esc", Math.min(innerWidth / 1600, innerHeight / 900));
}

// Mapa de CABA con un punto por cada paso bajo nivel
function dibujarMapa(sel) {
  const puntos = MAPA.pasos.map(([x, y]) => `<circle class="punto" cx="${x}" cy="${y}" r="17"/>`).join("");
  $(sel).innerHTML = `<svg class="mapa" viewBox="-20 -20 ${MAPA.ancho + 40} ${MAPA.alto + 40}" preserveAspectRatio="xMidYMid meet">
    <path class="tierra" d="${MAPA.contorno}"/>${puntos}</svg>`;
}

// Mapa del conurbano: los partidos, CABA en gris y un punto por paso bajo nivel
function dibujarGBA(sel) {
  const M = MAPA_GBA;
  $(sel).innerHTML = `<svg class="mapa" viewBox="-20 -20 ${M.ancho + 40} ${M.alto + 40}" preserveAspectRatio="xMidYMid meet">
    <path class="zona-gba" d="${M.partidos}"/><path class="zona-caba" d="${M.caba}"/>
    ${M.pasos.map(([x, y]) => `<circle class="punto" cx="${x}" cy="${y}" r="12"/>`).join("")}</svg>`;
}

