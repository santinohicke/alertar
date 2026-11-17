// Presentación animada de AlertAR: parte de hardware.
// Cada → avanza una etapa (la animación queda quieta hasta el siguiente →); ← vuelve atrás.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import gsap from "gsap";

// ---------- Escena ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e12);
scene.fog = new THREE.Fog(0x0b0e12, 30, 70);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 200);
const objetivo = new THREE.Vector3(0, 0.9, 14);
camera.position.set(0, 3.7, 20.6);
camera.lookAt(objetivo);

scene.add(new THREE.HemisphereLight(0xcfd8e6, 0x1a1d22, 0.9));
const sol = new THREE.DirectionalLight(0xffffff, 1.6);
sol.position.set(8, 14, 18);
sol.castShadow = true;
sol.shadow.mapSize.set(2048, 2048);
Object.assign(sol.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 60 });
scene.add(sol);

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...extra });
const caja = (w, h, d, material, r = 0.02) => {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), material);
  m.castShadow = true; m.receiveShadow = true;
  return m;
};
const cilindro = (rt, rb, h, material, seg = 32) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material);
  m.castShadow = true;
  return m;
};

// ---------- Componentes ----------
function crearESP32() {
  const g = new THREE.Group();
  g.add(caja(1.2, 0.06, 0.55, mat(0x1b2a4a), 0.01));
  const blindaje = caja(0.5, 0.09, 0.4, mat(0xc9ccd1, { metalness: 0.8, roughness: 0.3 }), 0.01);
  blindaje.position.set(0.25, 0.07, 0);
  g.add(blindaje);
  const antena = caja(0.22, 0.02, 0.4, mat(0x0d4f8b), 0.005);
  antena.position.set(0.6, 0.04, 0);
  g.add(antena);
  const usb = caja(0.14, 0.07, 0.18, mat(0x9aa0a6, { metalness: 0.7 }), 0.01);
  usb.position.set(-0.6, 0.06, 0);
  g.add(usb);
  const oro = mat(0xd4a017, { metalness: 0.9, roughness: 0.3 });
  for (let i = 0; i < 15; i++) {
    for (const z of [-0.24, 0.24]) {
      const p = cilindro(0.015, 0.015, 0.12, oro, 8);
      p.position.set(-0.55 + i * 0.075, -0.07, z);
      g.add(p);
    }
  }
  return g;
}

function crearUltrasonico() {
  const g = new THREE.Group();
  const cuerpo = cilindro(0.22, 0.22, 0.35, mat(0x1c1f24, { roughness: 0.8 }));
  cuerpo.rotation.x = Math.PI / 2;
  g.add(cuerpo);
  const frente = cilindro(0.2, 0.2, 0.02, mat(0x3a3f47, { roughness: 0.4 }));
  frente.rotation.x = Math.PI / 2;
  frente.position.z = 0.18;
  g.add(frente);
  const placa = caja(0.6, 0.04, 0.4, mat(0x1e7a46), 0.01);
  placa.position.set(0, -0.42, -0.1);
  g.add(placa);
  const cable = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, -0.18), new THREE.Vector3(0, -0.15, -0.35), new THREE.Vector3(0, -0.4, -0.25),
    ]), 20, 0.025, 8), mat(0x2b2f36));
  g.add(cable);
  return g;
}

function crearSensorAgua() {
  const g = new THREE.Group();
  const acero = mat(0xd5d9de, { metalness: 0.9, roughness: 0.25 });
  const vastago = cilindro(0.04, 0.04, 1.0, acero);
  g.add(vastago);
  const flotador = cilindro(0.16, 0.16, 0.22, acero);
  flotador.position.y = -0.15;
  g.add(flotador);
  const tuerca = cilindro(0.1, 0.1, 0.08, acero, 6);
  tuerca.position.y = 0.48;
  g.add(tuerca);
  return g;
}

function crearGabinete() {
  const g = new THREE.Group();
  const gris = mat(0x8d949c, { roughness: 0.5 });
  const base = caja(2.0, 1.1, 1.0, gris, 0.06);
  base.position.y = 0.55;
  g.add(base);
  const tapa = new THREE.Group();
  const placaTapa = caja(2.04, 0.1, 1.04, gris, 0.04);
  placaTapa.position.set(0, 0.05, 0.52);
  tapa.add(placaTapa);
  tapa.position.set(0, 1.1, -0.52);
  tapa.rotation.x = -1.9; // abierta
  g.add(tapa);
  const etiqueta = caja(0.7, 0.18, 0.01, mat(0xffb52e, { emissive: 0x332100 }), 0.01);
  etiqueta.position.set(0, 0.75, 0.51);
  g.add(etiqueta);
  g.userData.tapa = tapa;
  return g;
}

// ---------- Túnel ----------
const tunel = new THREE.Group();
const matTunel = mat(0x7f858c, { roughness: 0.95, side: THREE.DoubleSide, transparent: true });
{
  const exterior = new THREE.Shape();
  exterior.moveTo(-6.5, -0.5); exterior.lineTo(-6.5, 7.2); exterior.lineTo(6.5, 7.2); exterior.lineTo(6.5, -0.5);
  const hueco = new THREE.Path();
  hueco.moveTo(-4.5, -0.4); hueco.lineTo(-4.5, 3.6); hueco.quadraticCurveTo(-4.5, 5.2, -3, 5.2);
  hueco.lineTo(3, 5.2); hueco.quadraticCurveTo(4.5, 5.2, 4.5, 3.6); hueco.lineTo(4.5, -0.4);
  exterior.holes.push(hueco);
  const geo = new THREE.ExtrudeGeometry(exterior, { depth: 28, bevelEnabled: false, curveSegments: 24 });
  const m = new THREE.Mesh(geo, matTunel);
  m.position.z = -28;
  m.receiveShadow = true; m.castShadow = true;
  tunel.add(m);
}
const matRuta = mat(0x2a2d31, { roughness: 1, transparent: true });
const ruta = new THREE.Mesh(new THREE.PlaneGeometry(9, 56), matRuta);
ruta.rotation.x = -Math.PI / 2;
ruta.position.set(0, 0.01, 0);
ruta.receiveShadow = true;
tunel.add(ruta);
const matLinea = new THREE.MeshBasicMaterial({ color: 0xe8e8e8, transparent: true });
for (let z = -26; z < 27; z += 3) {
  const l = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 1.4), matLinea);
  l.rotation.x = -Math.PI / 2;
  l.position.set(0, 0.02, z);
  tunel.add(l);
}
const matLuz = new THREE.MeshBasicMaterial({ color: 0xfff1c9, transparent: true });
for (let z = -25; z < -1; z += 4) {
  const l = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.25), matLuz);
  l.position.set(0, 5.15, z);
  tunel.add(l);
  const p = new THREE.PointLight(0xffe2a8, 0, 9);
  p.position.set(0, 4.6, z);
  p.userData.luzTunel = true;
  tunel.add(p);
}
const piso = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), mat(0x161a1f, { roughness: 1 }));
piso.rotation.x = -Math.PI / 2;
piso.receiveShadow = true;
scene.add(piso);
scene.add(tunel);

// Sensores instalados (versiones chicas en su lugar definitivo)
const instalados = new THREE.Group();
const conos = [];
for (const x of [-2, 2]) {
  const s = crearUltrasonico();
  s.scale.setScalar(0.7);
  s.rotation.x = Math.PI / 2; // mirando hacia abajo
  s.position.set(x, 5.0, -6);
  instalados.add(s);
  const cono = new THREE.Mesh(new THREE.ConeGeometry(0.9, 4.7, 32, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x5fb8ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
  cono.position.set(x, 2.55, -6);
  instalados.add(cono);
  conos.push(cono);
}
const aguaInstalado = crearSensorAgua();
aguaInstalado.scale.setScalar(0.8);
aguaInstalado.position.set(-4.3, 0.6, -6);
instalados.add(aguaInstalado);
instalados.children.forEach(o => { if (!conos.includes(o)) o.scale.multiplyScalar(0.0001); });
scene.add(instalados);

// ---------- Semáforo y cartel ----------
const semaforo = new THREE.Group();
{
  const poste = cilindro(0.09, 0.09, 4, mat(0x50565e, { metalness: 0.6 }));
  poste.position.y = 2;
  semaforo.add(poste);
  const cuerpo = caja(0.6, 1.6, 0.5, mat(0x1d2025), 0.08);
  cuerpo.position.y = 4.6;
  semaforo.add(cuerpo);
}
const luces = {};
[["rojo", 0xff3b30, 5.1], ["amarillo", 0xffb020, 4.6], ["verde", 0x34c759, 4.1]].forEach(([n, c, y]) => {
  const m = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: c, emissiveIntensity: 0.05 });
  const l = new THREE.Mesh(new THREE.SphereGeometry(0.19, 24, 16), m);
  l.position.set(0, y, 0.22);
  semaforo.add(l);
  luces[n] = m;
});
semaforo.position.set(5.6, 0, 4);
semaforo.scale.setScalar(0.0001);
scene.add(semaforo);

function texturaCartel(l1, l2) {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 360;
  const x = c.getContext("2d");
  x.fillStyle = "#050505"; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = "#ffb52e";
  x.font = "bold 118px Consolas, monospace";
  x.textAlign = "center"; x.textBaseline = "middle";
  if (l2) { x.fillText(l1, 512, 110); x.fillText(l2, 512, 250); } else { x.fillText(l1, 512, 180); }
  // Rejilla oscura para que las letras se vean como puntos LED
  x.fillStyle = "rgba(5,5,5,0.85)";
  for (let i = 0; i < c.width; i += 9) x.fillRect(i, 0, 3, c.height);
  for (let j = 0; j < c.height; j += 9) x.fillRect(0, j, c.width, 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const cartel = new THREE.Group();
cartel.add(caja(4.7, 1.75, 0.25, mat(0x15171a), 0.04));
const caras = [
  ["PASO HABILITADO", ""],
  ["PRECAUCION", "VERIFICANDO AGUA"],
  ["PASO CERRADO", "AGUA CRITICA"],
].map(([a, b], i) => {
  const m = new THREE.MeshBasicMaterial({ map: texturaCartel(a, b), transparent: true, opacity: i === 0 ? 1 : 0 });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 1.58), m);
  p.position.z = 0.13 + i * 0.002;
  cartel.add(p);
  return m;
});
cartel.position.set(0, 6.2, 0.2);
cartel.scale.setScalar(0.0001);
scene.add(cartel);

// ---------- Escenario de presentación de piezas ----------
const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.4, 0.25, 64), mat(0x20252c, { roughness: 0.7 }));
pedestal.position.set(0, 0.12, 14.4);
pedestal.receiveShadow = true;
scene.add(pedestal);
const foco = new THREE.SpotLight(0xffffff, 60, 14, 0.55, 0.5);
foco.position.set(0, 7, 16.5);
foco.target.position.set(0, 0.5, 14.2);
foco.castShadow = true;
scene.add(foco, foco.target);
const esp32 = crearESP32(); esp32.scale.setScalar(1.8);
const ultra1 = crearUltrasonico(); const ultra2 = crearUltrasonico();
const agua = crearSensorAgua();
const gabinete = crearGabinete();
const escenario = [esp32, ultra1, ultra2, agua];
esp32.position.set(0, 0.9, 15.0);
ultra1.position.set(-2.3, 1.0, 13.8);
ultra2.position.set(2.3, 1.0, 13.8);
agua.position.set(0, 1.0, 13.0);
gabinete.position.set(0, 0, 14);
[...escenario, gabinete].forEach(o => { o.userData.escala = o.scale.x; o.scale.setScalar(0.0001); scene.add(o); });

// ---------- Lluvia y agua ----------
const N = 2500, LARGO = 0.45;
const pos = new Float32Array(N * 6);
for (let i = 0; i < N; i++) {
  const x = (Math.random() - 0.5) * 30, y = Math.random() * 16, z = -2 + Math.random() * 22;
  pos.set([x, y, z, x - 0.04, y + LARGO, z], i * 6);
}
const geoLluvia = new THREE.BufferGeometry();
geoLluvia.setAttribute("position", new THREE.BufferAttribute(pos, 3));
const matLluvia = new THREE.LineBasicMaterial({ color: 0xa9c9f5, transparent: true, opacity: 0, depthWrite: false });
scene.add(new THREE.LineSegments(geoLluvia, matLluvia));

const geoAgua = new THREE.BoxGeometry(8.98, 1, 28);
geoAgua.translate(0, 0.5, -14);
const aguaTunel = new THREE.Mesh(geoAgua, new THREE.MeshStandardMaterial({
  color: 0x2f7fd1, transparent: true, opacity: 0, roughness: 0.15, metalness: 0.1 }));
aguaTunel.scale.y = 0.0001;
scene.add(aguaTunel);

// ---------- Estado inicial del túnel (invisible) ----------
const matsTunel = [matTunel, matRuta, matLinea, matLuz];
matsTunel.forEach(m => { m.opacity = 0; });
tunel.visible = false; // no tapa el fondo ni hace sombra mientras se presentan las piezas
const luzTunel = { v: 0 };
const giro = { v: 0.35 };

// ---------- Interfaz ----------
const $ = s => document.querySelector(s);
const total = { v: 0 };
const fmt = v => "$" + Math.round(v).toLocaleString("es-AR");
const pintarTotal = () => { $("#total-num").textContent = total.v >= 12600000 ? "≈ $12,7 millones" : fmt(total.v); };

// ---------- Línea de tiempo por etapas ----------
const tl = gsap.timeline({ paused: true, defaults: { duration: 1.2, ease: "power2.inOut" } });
const etapas = ["inicio"];
tl.addLabel("inicio", 0);
// Cada etapa arranca en su etiqueta: el set vacío sirve de ancla para los "<" que siguen.
const etapa = nombre => { const t = tl.duration(); tl.addLabel(nombre, t); tl.set({}, {}, t); etapas.push(nombre); };
const tarjeta = (sel, entra = true) => tl.to(sel, { opacity: entra ? 1 : 0, x: entra ? 0 : 40, duration: 0.6 }, "<");
const aparecer = (obj, extra = {}) => tl.to(obj.scale, { x: obj.userData.escala || 1, y: obj.userData.escala || 1, z: obj.userData.escala || 1, ease: "back.out(1.6)", ...extra }, "<");
const sumar = (hasta) => tl.to(total, { v: hasta, duration: 1.0, ease: "power1.out", onUpdate: pintarTotal }, "<");
const camara = (p, o, dur = 2.2) => {
  tl.to(camera.position, { x: p[0], y: p[1], z: p[2], duration: dur, onUpdate: () => camera.lookAt(objetivo) }, "<");
  tl.to(objetivo, { x: o[0], y: o[1], z: o[2], duration: dur }, "<");
};
gsap.set(".tarjeta", { x: 40 });

// 1. ESP32
etapa("esp32");
tl.to("#titulo", { opacity: 0, duration: 0.5 }, "<");
tl.to(["#seccion", "#total"], { opacity: 1, duration: 0.5 }, "<");
aparecer(esp32);
tarjeta("#t-esp32");
sumar(15000);

// 2. Ultrasónicos
etapa("ultra");
tarjeta("#t-esp32", false);
aparecer(ultra1); aparecer(ultra2, { delay: 0.15 });
tarjeta("#t-ultra");
sumar(75000);

// 3. Sensor de agua
etapa("agua");
tarjeta("#t-ultra", false);
aparecer(agua);
tarjeta("#t-agua");
sumar(89000);

// 4. Todo entra al gabinete
etapa("caja");
tarjeta("#t-agua", false);
tl.to(giro, { v: 0, duration: 0.6 }, "<");
aparecer(gabinete);
escenario.forEach((o, i) => {
  tl.to(o.position, { x: [-0.5, -0.6, 0.6, 0.5][i] ?? 0, y: 0.5, z: 14, duration: 1.0, delay: 0.5 + i * 0.1 }, "<");
  tl.to(o.scale, { x: o.userData.escala * 0.3, y: o.userData.escala * 0.3, z: o.userData.escala * 0.3, duration: 1.0 }, "<");
});
tl.to(gabinete.userData.tapa.rotation, { x: 0, duration: 0.8, ease: "power2.in" }, ">-0.2");
escenario.forEach(o => tl.to(o.scale, { x: 0.0001, y: 0.0001, z: 0.0001, duration: 0.01 }, "<"));
tarjeta("#t-caja");

// 5. Se aleja la cámara y aparece el túnel; todo va a su lugar
etapa("tunel");
tarjeta("#t-caja", false);
tl.set(tunel, { visible: true }, "<");
tl.to(matsTunel, { opacity: 1, duration: 1.4 }, "<");
tl.to(pedestal.scale, { x: 0.0001, y: 0.0001, z: 0.0001, duration: 0.8 }, "<");
tl.to(foco, { intensity: 0, duration: 0.8 }, "<");
tl.to(luzTunel, { v: 2.5, duration: 1.4, onUpdate: () => tunel.children.forEach(c => { if (c.userData.luzTunel) c.intensity = luzTunel.v; }) }, "<");
camara([13.5, 6.8, 19], [3.2, 2.6, -2]);
tl.to(gabinete.position, { x: 5.3, y: 1.4, z: 0.6, duration: 1.6 }, "<0.4");
tl.to(gabinete.scale, { x: 0.55, y: 0.55, z: 0.55, duration: 1.6 }, "<");
instalados.children.filter(o => !conos.includes(o)).forEach((o, i) => {
  const e = i === 2 ? 0.8 : 0.7;
  tl.to(o.scale, { x: e, y: e, z: e, ease: "back.out(1.6)", duration: 0.8, delay: 0.25 * i }, "<0.3");
});
tl.to(conos.map(c => c.material), { opacity: 0.12, duration: 0.8 }, ">-0.2");
tarjeta("#t-tunel");

// 6. Semáforo y cartel
etapa("aviso");
tarjeta("#t-tunel", false);
camara([9.5, 4.6, 15.5], [3.4, 3.4, 0.5]);
aparecer(semaforo, { delay: 0.6 });
tl.to(luces.verde, { emissiveIntensity: 2.2, duration: 0.5 }, ">-0.2");
aparecer(cartel, { delay: 0.1 });
tarjeta("#t-aviso");
sumar(9489000);

// 7. Instalación y energía
etapa("instal");
tarjeta("#t-aviso", false);
tarjeta("#t-instal");
sumar(12669000);

// 8. Empieza a llover: agua pendiente
etapa("lluvia");
tarjeta("#t-instal", false);
tl.to("#total", { opacity: 0, duration: 0.5 }, "<");
camara([8.5, 3.6, 14], [3.0, 2.6, -1]);
tl.to(matLluvia, { opacity: 0.9, duration: 1.0 }, "<");
tl.to(aguaTunel.material, { opacity: 0.75, duration: 0.6 }, "<0.5");
tl.to(aguaTunel.scale, { y: 0.35, duration: 2.0 }, "<");
tl.to(luces.verde, { emissiveIntensity: 0.05, duration: 0.3 }, "<0.8");
tl.to(luces.amarillo, { emissiveIntensity: 2.4, duration: 0.3 }, "<");
tl.to(caras[0], { opacity: 0, duration: 0.3 }, "<");
tl.to(caras[1], { opacity: 1, duration: 0.3 }, "<");
tarjeta("#t-lluvia");

// 9. Agua confirmada: paso cerrado
etapa("cerrado");
tarjeta("#t-lluvia", false);
tl.to(aguaTunel.scale, { y: 1.1, duration: 2.2 }, "<");
tl.to(luces.amarillo, { emissiveIntensity: 0.05, duration: 0.3 }, "<1.0");
tl.to(luces.rojo, { emissiveIntensity: 2.6, duration: 0.3 }, "<");
tl.to(caras[1], { opacity: 0, duration: 0.3 }, "<");
tl.to(caras[2], { opacity: 1, duration: 0.3 }, "<");
tarjeta("#t-cerrado");
tl.addLabel("fin", tl.duration());

// ---------- Navegación ----------
let actual = 0;
const puntos = $("#puntos");
etapas.forEach(() => puntos.appendChild(document.createElement("i")));
const pintarPuntos = () => [...puntos.children].forEach((p, i) => p.classList.toggle("on", i === actual));
pintarPuntos();
let tween = null;
function ir(i) {
  if (i < 0 || i >= etapas.length) return;
  actual = i;
  pintarPuntos();
  if (tween) tween.kill();
  // La etapa i se ve completa cuando la línea llega al comienzo de la etapa siguiente.
  const destino = i === 0 ? "inicio" : (etapas[i + 1] || "fin");
  tween = tl.tweenTo(destino, { ease: "none" });
}
addEventListener("keydown", e => {
  if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); ir(actual + 1); }
  else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); ir(actual - 1); }
  else if (e.key === "f" || e.key === "F") {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen();
  }
});
addEventListener("click", () => ir(actual + 1));
// Para probar desde la consola: __alertar.tl.seek("cerrado")
window.__alertar = { tl, etapas, ir };

// ---------- Bucle ----------
const reloj = new THREE.Clock();
function bucle() {
  const dt = Math.min(reloj.getDelta(), 0.05);
  escenario.forEach(o => { o.rotation.y += giro.v * dt; });
  if (matLluvia.opacity > 0.01) {
    const p = geoLluvia.attributes.position.array;
    for (let i = 0; i < N; i++) {
      const k = i * 6;
      let y = p[k + 1] - 20 * dt;
      if (y < 0) y += 16;
      p[k + 1] = y; p[k + 4] = y + LARGO;
    }
    geoLluvia.attributes.position.needsUpdate = true;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(bucle);
}
bucle();

addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
