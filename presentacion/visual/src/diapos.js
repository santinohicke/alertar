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

  // ================= Antes del hardware =================
  function intro() {
    // El problema: una noticia por diapositiva
    for (let i = 1; i <= 4; i++) {
      etapa("noticia" + i);
      cambiar(`#d-n${i}`);
      tl.to(`#d-n${i} .noticia-foto img`, { scale: 1, duration: 2.5, ease: "power2.out" }, "<");
      ap(`#d-n${i} .noticia-txt`, "<0.2", { x: 0 });
    }

    // Cuántos pasos hay: número y foto, después el mapa, después el conurbano
    etapa("pasos");
    cambiar("#d-pasos");
    contar("#num-caba", 0, 29, entero, "<0.2", 1.1);
    ap("#foto-paso", "<0.3");
    tl.to("#mapa-pasos", { opacity: 1, duration: 0.6 }, "<0.2");
    puntosMapa("#mapa-pasos", "<0.2");
    etapa("conurbano");
    cambiar("#d-conurbano");
    contar("#num-gba", 0, PASOS_GBA, entero, "<0.2", 1.2);
    ap("#foto-gba", "<0.3");
    tl.to("#mapa-gba", { opacity: 1, duration: 0.6 }, "<0.2");
    tl.to("#mapa-gba .punto", { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2.5)", stagger: 0.015 }, "<0.2");

    // Cada vez llueve más
    etapa("lluvia2030");
    cambiar("#d-lluvia");
    ap("#lluvia1", "<0.3");
    tl.to(".barras i", { scaleY: 1, duration: 0.9, stagger: 0.25, ease: "power2.out" }, "<0.3");
    etapa("superNino");
    ap("#lluvia2");
    tl.to(".meses div", { opacity: 1, x: 0, duration: 0.5, stagger: 0.2 }, "<0.3");

    // Cómo se resuelve hoy
    etapa("hoy");
    cambiar("#d-hoy1");
    tl.to("#lt1", { opacity: 1, y: 0, duration: 0.5 }, "<0.4");
    tl.to("#lf1", { scaleX: 1, duration: 0.6 }, ">");
    tl.to("#lt2", { opacity: 1, y: 0, duration: 0.5 }, ">");
    tl.to("#lf2", { scaleX: 1, duration: 0.6 }, ">");
    tl.to("#lt3", { opacity: 1, y: 0, duration: 0.6, ease: "back.out(2)" }, ">");
    ap("#cita-hoy", ">0.3");
    etapa("alertas");
    cambiar("#d-hoy2");
    ap("#d-hoy2 .panel", "<0.3", { stagger: 0.25 });
    contar("#num-est", 0, 18, entero, "<0.3", 1.0);
    contar("#num-pluv", 0, 92, entero, "<0.2", 1.0);
    etapa("ninguno");
    tl.to("#sello-hoy", { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(3)" }, "<");

    // La solución
    etapa("solucion");
    cambiar("#d-solucion");
    ap("#sol-encab", "<0.3");
    ap(".tres .panel", ">-0.2", { stagger: 0.25 });
    for (let i = 1; i <= 4; i++) {
      etapa("diferencia" + i);
      if (i === 1) cambiar("#d-difs");
      ap("#dif" + i, i === 1 ? "<0.4" : "<");
    }
  }

  // Sale de la última diapositiva antes del 3D
  function salir() { cambiar(null); }

  // ================= Después del hardware =================
  function cierre(ocultar3D) {
    // Cómo funciona: los tres colores se van armando
    const encender = (id, color) => {
      tl.to(id, { opacity: 1, borderColor: color, duration: 0.5 }, "<");
      tl.to(id + " .luz", { backgroundColor: color, boxShadow: `0 0 50px ${color}`, duration: 0.5 }, "<");
      tl.to(id + " .estado", { color, duration: 0.5 }, "<");
      ap(id + " .cod", "<0.2", { stagger: 0.18 });
    };
    etapa("logica");
    ocultar3D();
    cambiar("#d-logica");
    encender("#col-verde", COLOR.ok);
    etapa("logica2");
    encender("#col-amarillo", COLOR.warn);
    etapa("logica3");
    encender("#col-rojo", COLOR.crit);
    etapa("failsafe");
    cambiar("#d-failsafe");
    ap("#d-failsafe .panel", "<0.3", { stagger: 0.3 });

    // Datos y comunicación: el JSON viaja del túnel al servidor, despacio para poder leerlo
    const tit = "#datos-tit";
    etapa("datos");
    cambiar("#d-datos");
    viajar("#pq-json", ...IDA, "<0.8", 3.2);
    tl.to("pre.json span", { opacity: 1, duration: 0.15, stagger: 0.32 }, "<");
    viajar("#pq-ack", ...VUELTA, ">0.4", 2.6);

    etapa("datos-cuando");
    texto(tit, "El evento que viaja", "Cuándo se manda");
    tl.to("#dat-json", { opacity: 0, duration: 0.4 }, "<");
    tl.to("#dat-cuando", { opacity: 1, duration: 0.4 }, "<0.2");
    ap("#dat-cuando .panel", "<", { stagger: 0.3 });
    viajar("#pq-a", ...IDA, "<", 2.2);
    viajar("#pq-b", ...IDA, ">0.3", 2.2);
    viajar("#pq-lote", ...IDA, ">0.3", 2.4);

    etapa("datos-corte");
    texto(tit, "Cuándo se manda", "Si se corta internet");
    tl.to("#dat-cuando", { opacity: 0, duration: 0.4 }, "<");
    tl.to("#dat-corte", { opacity: 1, duration: 0.4 }, "<0.2");
    ap("#dat-corte .panel", "<", { stagger: 0.3 });
    tl.to("#cable", { backgroundColor: COLOR.crit, opacity: 0.45, duration: 0.4 }, "<");
    tl.to("#corte", { opacity: 1, duration: 0.3 }, "<");
    tl.to("#cola i", { opacity: 1, scale: 1, duration: 0.15, stagger: 0.1 }, "<0.4");

    etapa("datos-vuelve");
    texto(tit, "Si se corta internet", "Cuando vuelve internet");
    tl.to("#dat-corte", { opacity: 0, duration: 0.4 }, "<");
    tl.to("#dat-vuelve", { opacity: 1, duration: 0.4 }, "<0.2");
    ap("#dat-vuelve .panel", "<", { stagger: 0.3 });
    tl.to("#cable", { backgroundColor: COLOR.ok, opacity: 1, duration: 0.4 }, "<");
    tl.to("#corte", { opacity: 0, duration: 0.3 }, "<");
    viajar("#pq-lote", ...IDA, "<0.3", 2.2);
    tl.to("#cola i", { opacity: 0, scale: 0.3, duration: 0.12, stagger: { each: 0.08, from: "end" } }, "<");
    viajar("#pq-ack", ...VUELTA, ">0.2", 2.2);

    etapa("seguridad");
    texto(tit, "Cuando vuelve internet", "Seguridad");
    tl.to("#dat-vuelve", { opacity: 0, duration: 0.4 }, "<");
    tl.to("#dat-seg", { opacity: 1, duration: 0.4 }, "<0.2");
    ap("#dat-seg .panel", "<", { stagger: 0.3 });
    tl.to("#candado", { opacity: 1, duration: 0.4 }, "<");

    // Tecnología
    etapa("tecnologia");
    cambiar("#d-tecno");
    ap(".pila > *", "<0.3", { stagger: 0.2 });

    // Negocio: lo que cuesta una muerte y un auto, contra un equipo
  }

  return { intro, salir, cierre };
}
