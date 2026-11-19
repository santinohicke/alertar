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

export function crearDiapos(tl, etapa) {
  ajustar();
  addEventListener("resize", ajustar);
  ponerIconos();
  dibujarMapa("#mapa-pasos");
  dibujarMapa("#mapa-caba");
  dibujarGBA("#mapa-gba");
  dibujarGBA("#mapa-gba-total");
  $("#cola").innerHTML = "<i></i>".repeat(24);

  // Estado inicial de lo que aparece animado
  gsap.set(".ap", { opacity: 0, y: 26 });
  gsap.set(".diapo:not(#d-portada)", { autoAlpha: 0 });
  gsap.set(".noticia-txt", { x: -50, y: 0 });
  gsap.set(".noticia-foto img", { scale: 1.15 });
  gsap.set("#mapa-pasos, #mapa-gba", { opacity: 0 });
  gsap.set(".mapa .punto", { opacity: 0, scale: 0, transformOrigin: "50% 50%" });
  gsap.set(".barras i", { scaleY: 0 });
  gsap.set(".meses div", { opacity: 0, x: -30 });
  gsap.set(".linea-tiempo .paso", { opacity: 0, y: 20 });
  gsap.set(".linea-tiempo .flecha", { scaleX: 0 });
  gsap.set("#sello-hoy", { xPercent: -50, yPercent: -50, x: 0, rotation: 0, scale: 1.6, opacity: 0 });
  gsap.set(".color", { opacity: 0.35 });
  gsap.set(".color .luz", { boxShadow: "0 0 0px rgba(0,0,0,0)" });
  gsap.set("pre.json span", { opacity: 0 });
  gsap.set("#cola i", { opacity: 0, scale: 0.3 });
  gsap.set(".barra", { scaleX: 0 });

  // ---------- Ayudas ----------
  let actual = "#d-portada";
  const cambiar = sel => { // pasa de una diapositiva a otra
    // autoAlpha también oculta (visibility) la diapositiva que sale: así sus links no tapan a las demás
    if (actual) tl.to(actual, { autoAlpha: 0, duration: 0.45 }, "<");
    if (sel) tl.to(sel, { autoAlpha: 1, duration: 0.6 }, actual ? "<0.25" : "<");
    actual = sel;
  };
  const ap = (sel, pos = "<", extra = {}) =>
    tl.to(sel, { opacity: 1, y: 0, duration: 0.7, ease: "power2.out", ...extra }, pos);
  const contar = (sel, desde, hasta, fmt = entero, pos = "<", dur = 1.2) => {
    const o = { v: desde };
    tl.to(o, { v: hasta, duration: dur, ease: "power1.out", onUpdate: () => { $(sel).textContent = fmt(o.v); } }, pos);
  };
  const texto = (sel, antes, despues, pos = "<") => { // cambia un texto (y lo devuelve al volver atrás)
    const o = { p: 0 };
    tl.to(o, { p: 1, duration: 0.01, onUpdate: () => { $(sel).textContent = o.p >= 1 ? despues : antes; } }, pos);
  };
  const viajar = (sel, desde, hasta, pos = ">", dur = 2.4) => { // un paquete recorre el cable
    tl.set(sel, { opacity: 1, x: desde }, pos);
    tl.to(sel, { x: hasta, duration: dur, ease: "power1.inOut" }, ">");
    tl.to(sel, { opacity: 0, duration: 0.3 }, ">0.3");
  };
  const IDA = [0, 640], VUELTA = [560, 0]; // recorrido de los paquetes sobre el cable
  const puntosMapa = (sel, pos) =>
    tl.to(sel + " .punto", { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(2.5)", stagger: 0.05 }, pos);
  const barra = (id, montoSel, monto, pos) => {
    tl.to(id, { scaleX: 1, duration: 1.1, ease: "power2.out" }, pos);
    contar(montoSel, 0, monto, pesos, "<", 1.1);
  };

  return {};
}
