// Presentación animada de AlertAR, parte de hardware (versión 2).
// Cada → avanza una etapa (la animación queda quieta hasta el siguiente →); ← vuelve atrás.
// Piezas electrónicas: modelos 3D de la biblioteca de KiCad (CC-BY-SA 4.0), en modelos/.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { VRMLLoader } from "three/examples/jsm/loaders/VRMLLoader.js";
import gsap from "gsap";
import { crearDiapos } from "./diapos.js";
import wrlModulo from "../modelos/ESP32-WROOM-32.wrl";
import wrlUsb from "../modelos/USB_Micro-B_Molex_47346-0001.wrl";
import wrlPines19 from "../modelos/PinHeader_1x19_P2.54mm_Vertical.wrl";
import wrlPines4 from "../modelos/PinHeader_1x04_P2.54mm_Vertical.wrl";
import wrlCristal from "../modelos/Crystal_HC49-4H_Vertical.wrl";

// ---------- Escena ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);
renderer.domElement.style.opacity = 0; // el 3D aparece recién en la parte de hardware

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f12);
scene.fog = new THREE.Fog(0x0d0f12, 48, 115);
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  pmrem.dispose();
}

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.05, 300);
const objetivo = new THREE.Vector3(0, 0.9, 46);
camera.position.set(0, 3.4, 52.4);
camera.lookAt(objetivo);
// Corre la imagen hacia la izquierda: a la derecha van las tarjetas de texto.
function encuadre() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.setViewOffset(w, h, w * 0.16, 0, w, h);
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
encuadre();

const cielo = new THREE.HemisphereLight(0xd6e0ee, 0x20242b, 1.0);
scene.add(cielo);
const sol = new THREE.DirectionalLight(0xffffff, 1.7);
sol.position.set(14, 22, 30);
sol.castShadow = true;
sol.shadow.mapSize.set(2048, 2048);
sol.shadow.bias = -0.0006;
sol.shadow.normalBias = 0.02;
Object.assign(sol.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 90 });
scene.add(sol);

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...extra });
const caja = (w, h, d, material, r = 0.02) => {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2)), material);
  m.castShadow = true; m.receiveShadow = true;
  return m;
};
const cilindro = (rt, rb, h, material, seg = 32) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material);
  m.castShadow = true; m.receiveShadow = true;
  return m;
};

// ---------- Modelos de KiCad ----------
// Los .wrl de KiCad usan Z hacia arriba y 1 unidad = 2,54 mm. Se devuelven en milímetros,
// con Y hacia arriba y centrados en X/Z, apoyados en y = 0.
const vrml = new VRMLLoader();
function kicad(texto) {
  const crudo = vrml.parse(texto, "");
  crudo.rotation.x = -Math.PI / 2;
  crudo.scale.setScalar(2.54);
  const envoltura = new THREE.Group();
  envoltura.add(crudo);
  envoltura.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(envoltura);
  const c = b.getCenter(new THREE.Vector3());
  crudo.position.set(-c.x, -b.min.y, -c.z);
  envoltura.traverse(o => {
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true;
      // Los materiales Phong del VRML se ven planos con la iluminación física: se pasan a Standard.
      const m = o.material;
      if (m && m.color) {
        const dorado = m.color.r > 0.6 && m.color.g > 0.45 && m.color.b < 0.35;
        const metal = dorado || (m.color.r > 0.55 && m.color.g > 0.55 && m.color.b > 0.55);
        o.material = new THREE.MeshStandardMaterial({
          color: m.color, roughness: metal ? 0.26 : 0.48, metalness: dorado ? 0.88 : (metal ? 0.78 : 0.12) });
      }
    }
  });
  return envoltura;
}
const tam = o => new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());

// ESP32 DevKitC armado con piezas reales: módulo WROOM-32, micro USB y dos tiras de 19 pines.
function crearESP32() {
  const mm = new THREE.Group();
  const pcb = caja(55, 1.6, 28, mat(0x18254a, { roughness: 0.45 }), 0.6);
  pcb.position.y = 0.8;
  mm.add(pcb);
  const modulo = kicad(wrlModulo);
  const t = tam(modulo);
  if (t.z > t.x) modulo.rotation.y = Math.PI / 2; // el lado largo del módulo, a lo largo de la placa
  modulo.position.set(13, 1.6, 0);
  mm.add(modulo);
  const usb = kicad(wrlUsb);
  if (tam(usb).x > tam(usb).z) usb.rotation.y = Math.PI / 2;
  usb.position.set(-25.5, 1.6, 0);
  mm.add(usb);
  for (const z of [-12.7, 12.7]) {
    const pines = kicad(wrlPines19);
    if (tam(pines).z > tam(pines).x) pines.rotation.y = Math.PI / 2;
    pines.rotation.x = Math.PI; // los pines salen hacia abajo
    pines.position.set(0, 0, z);
    mm.add(pines);
  }
  for (const z of [-8, 8]) { // botones EN y BOOT
    const boton = caja(3.5, 1.4, 6, mat(0xb8bcc2, { metalness: 0.75, roughness: 0.3 }), 0.3);
    boton.position.set(-19, 2.3, z);
    mm.add(boton);
  }
  const uart = caja(5, 0.9, 5, mat(0x141619, { roughness: 0.35 }), 0.2); // CP2102 USB-UART
  uart.position.set(-13, 2.05, 0);
  mm.add(uart);
  const reg = caja(3.6, 1.5, 6.5, mat(0x181a1e, { roughness: 0.4 }), 0.2); // regulador 3,3 V
  reg.position.set(-4.5, 2.35, -5.5);
  mm.add(reg);
  const disip = caja(1.4, 0.4, 3.2, mat(0xcfd4da, { metalness: 0.85, roughness: 0.25 }), 0.1);
  disip.position.set(-6.8, 1.8, -5.5);
  mm.add(disip);
  const matSmd = mat(0xc89b62, { roughness: 0.4, metalness: 0.3 });
  for (const [x, z] of [[-8.5, 4.5], [-8.5, 7], [-17.5, -4], [-3.5, 4.5]]) {
    const smd = caja(1.8, 0.8, 1.0, matSmd, 0.15);
    smd.position.set(x, 2.0, z);
    mm.add(smd);
  }
  const led = caja(1.6, 0.8, 0.8, mat(0xff3b30, { emissive: 0xff2a1a, emissiveIntensity: 1.1 }), 0.2);
  led.position.set(-14, 2, -10);
  mm.add(led);
  const g = new THREE.Group();
  mm.scale.setScalar(0.045);
  g.add(mm);
  return g;
}

// JSN-SR04T: sonda impermeable negra con cable, y su placa con cristal y 4 pines.
function crearUltrasonico({ conPlaca = true } = {}) {
  const g = new THREE.Group();
  const negro = mat(0x15171b, { roughness: 0.75 });
  const sonda = cilindro(0.26, 0.26, 0.42, negro);
  sonda.rotation.x = Math.PI / 2;
  g.add(sonda);
  const borde = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.03, 12, 40), negro);
  borde.position.z = 0.21;
  g.add(borde);
  const membrana = cilindro(0.22, 0.22, 0.02, mat(0x2e333b, { roughness: 0.35 }));
  membrana.rotation.x = Math.PI / 2;
  membrana.position.z = 0.215;
  g.add(membrana);
  const rosca = cilindro(0.16, 0.16, 0.22, negro);
  rosca.rotation.x = Math.PI / 2;
  rosca.position.z = -0.3;
  g.add(rosca);
  if (conPlaca) {
    const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, -0.42), new THREE.Vector3(0, -0.2, -0.8), new THREE.Vector3(0.2, -0.75, -0.6),
      new THREE.Vector3(0.3, -0.95, -0.2)]), 30, 0.03, 8), negro);
    g.add(cable);
    const mm = new THREE.Group();
    const placa = caja(41, 1.6, 28, mat(0x1f7a3f, { roughness: 0.5 }), 0.6);
    placa.position.y = 0.8;
    mm.add(placa);
    const cristal = kicad(wrlCristal);
    cristal.position.set(-6, 1.6, 4);
    mm.add(cristal);
    const pines = kicad(wrlPines4);
    if (tam(pines).z > tam(pines).x) pines.rotation.y = Math.PI / 2;
    pines.position.set(4, 1.6, -11);
    mm.add(pines);
    const chip = caja(9, 1.8, 6, mat(0x111111), 0.3);
    chip.position.set(10, 2.4, 5);
    mm.add(chip);
    mm.scale.setScalar(0.025);
    mm.position.set(0.25, -1.05, 0);
    g.add(mm);
  }
  return g;
}

function crearSensorAgua() {
  const g = new THREE.Group();
  const acero = mat(0xd5d9de, { metalness: 0.9, roughness: 0.25 });
  g.add(cilindro(0.045, 0.045, 1.1, acero));
  const flotador = cilindro(0.17, 0.17, 0.26, acero);
  flotador.position.y = -0.18;
  g.add(flotador);
  for (const y of [0.5, 0.36]) {
    const tuerca = cilindro(0.11, 0.11, 0.07, acero, 6);
    tuerca.position.y = y;
    g.add(tuerca);
  }
  const cable = cilindro(0.025, 0.025, 0.5, mat(0x222222));
  cable.position.y = 0.8;
  g.add(cable);
  return g;
}

// Gabinete estanco abierto (hueco), con la tapa abisagrada atrás.
// Adentro van la batería de respaldo y la fuente; el ESP32 entra en la animación.
const GAB = { W: 2.4, H: 0.9, D: 1.2, e: 0.06 };
function crearGabinete() {
  const { W, H, D, e } = GAB;
  const g = new THREE.Group();
  const gris = mat(0xa4abb3, { roughness: 0.42, metalness: 0.25 });
  const burleteMat = mat(0x16181c, { roughness: 0.9 });
  const piso = caja(W, e, D, gris, 0.02);
  piso.position.y = e / 2;
  g.add(piso);
  for (const [w, d, x, z] of [[W, e, 0, D / 2 - e / 2], [W, e, 0, -D / 2 + e / 2], [e, D, W / 2 - e / 2, 0], [e, D, -W / 2 + e / 2, 0]]) {
    const pared = caja(w, H, d, gris, 0.02);
    pared.position.set(x, H / 2, z);
    g.add(pared);
    const burlete = caja(w * 0.99, 0.022, d * 0.99, burleteMat, 0.005);
    burlete.position.set(x, H + 0.01, z);
    g.add(burlete);
  }
  const placaMontaje = new THREE.Mesh(new THREE.PlaneGeometry(W - 2 * e, D - 2 * e), mat(0xd06a28, { roughness: 0.55, metalness: 0.2 }));
  placaMontaje.rotation.x = -Math.PI / 2;
  placaMontaje.position.y = e + 0.003;
  placaMontaje.receiveShadow = true;
  g.add(placaMontaje);
  const riel = caja(0.95, 0.025, 0.14, mat(0xc4cbd2, { metalness: 0.85, roughness: 0.25 }), 0.005);
  riel.position.set(0.72, e + 0.015, -0.3);
  g.add(riel);
  const tapa = new THREE.Group();
  const placaTapa = caja(W + 0.04, 0.08, D + 0.04, gris, 0.03);
  placaTapa.position.set(0, 0.04, (D + 0.04) / 2);
  tapa.add(placaTapa);
  // Etiqueta de riesgo eléctrico y cerradura en el frente de la puerta
  const texRiesgo = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const x = c.getContext("2d");
    x.fillStyle = "#f5b400"; x.beginPath(); x.moveTo(64, 10); x.lineTo(118, 112); x.lineTo(10, 112); x.closePath(); x.fill();
    x.lineWidth = 7; x.strokeStyle = "#141619"; x.stroke();
    x.fillStyle = "#141619"; x.beginPath();
    x.moveTo(68, 34); x.lineTo(48, 70); x.lineTo(63, 70); x.lineTo(54, 100); x.lineTo(80, 62); x.lineTo(64, 62); x.closePath(); x.fill();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const etqPuerta = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.36),
    new THREE.MeshBasicMaterial({ map: texRiesgo, transparent: true }));
  etqPuerta.rotation.x = -Math.PI / 2;
  etqPuerta.rotation.z = Math.PI / 2; // queda derecho cuando el gabinete rota -90° en la pared
  etqPuerta.position.set(0, 0.083, (D + 0.04) / 2);
  tapa.add(etqPuerta);
  const cerradura = cilindro(0.055, 0.055, 0.025, mat(0x22262c, { metalness: 0.7, roughness: 0.3 }), 20);
  cerradura.position.set(0, 0.09, D - 0.06);
  tapa.add(cerradura);
  tapa.position.set(0, H, -D / 2 - 0.02);
  tapa.rotation.x = -1.9;
  g.add(tapa);
  // Batería de respaldo (12 V)
  const bateria = new THREE.Group();
  const cuerpo = caja(0.6, 0.5, 0.42, mat(0x1c1e22, { roughness: 0.7 }), 0.03);
  cuerpo.position.y = 0.25;
  bateria.add(cuerpo);
  const franja = caja(0.605, 0.12, 0.425, mat(0x2f6fd6), 0.01);
  franja.position.y = 0.3;
  bateria.add(franja);
  [[-0.18, 0xd63a2f], [0.18, 0x222222]].forEach(([x, c]) => {
    const borne = cilindro(0.04, 0.04, 0.07, mat(c, { metalness: 0.5 }), 12);
    borne.position.set(x, 0.535, 0);
    bateria.add(borne);
  });
  bateria.position.set(0.72, e, 0.24);
  // Fuente
  const fuente = new THREE.Group();
  const pcbF = caja(0.6, 0.04, 0.32, mat(0x1f7a3f, { roughness: 0.5 }), 0.01);
  pcbF.position.y = 0.02;
  fuente.add(pcbF);
  const trafo = caja(0.2, 0.16, 0.18, mat(0x2a5bd7), 0.02);
  trafo.position.set(-0.13, 0.12, 0);
  fuente.add(trafo);
  const capacitor = cilindro(0.05, 0.05, 0.16, mat(0x202226), 16);
  capacitor.position.set(0.13, 0.12, 0.05);
  fuente.add(capacitor);
  const bornera = caja(0.12, 0.08, 0.1, mat(0x2c8f4a), 0.01);
  bornera.position.set(0.22, 0.08, -0.08);
  fuente.add(bornera);
  fuente.position.set(0.72, e + 0.025, -0.3);
  const internos = [bateria, fuente];
  internos.forEach(o => { o.scale.setScalar(0.0001); g.add(o); });
  g.userData.tapa = tapa;
  g.userData.internos = internos;
  return g;
}

// Camión: el frente mira hacia -z y apoya en y = 0.
function crearCamion(colorCabina) {
  const g = new THREE.Group();
  const chasis = caja(2.2, 0.3, 8.6, mat(0x2a2d31), 0.05);
  chasis.position.y = 0.75;
  g.add(chasis);
  const paragolpes = caja(2.44, 0.32, 0.22, mat(0x202328, { roughness: 0.5, metalness: 0.4 }), 0.06);
  paragolpes.position.set(0, 0.88, -4.28);
  g.add(paragolpes);
  const cabina = caja(2.4, 2.3, 2.1, mat(colorCabina, { roughness: 0.35, metalness: 0.35 }), 0.15);
  cabina.position.set(0, 2.0, -3.25);
  g.add(cabina);
  const parrilla = caja(1.5, 0.55, 0.05, mat(0x16181c, { roughness: 0.6, metalness: 0.5 }), 0.03);
  parrilla.position.set(0, 1.55, -4.31);
  g.add(parrilla);
  const vidrio = caja(2.1, 0.85, 0.05, mat(0x1d2a38, { roughness: 0.08, metalness: 0.75 }), 0.02);
  vidrio.position.set(0, 2.55, -4.31);
  g.add(vidrio);
  for (const x of [-1.28, 1.28]) {
    const espejo = caja(0.12, 0.48, 0.22, mat(0x181a1e, { roughness: 0.4 }), 0.03);
    espejo.position.set(x, 2.45, -3.95);
    g.add(espejo);
  }
  const carga = caja(2.5, 2.5, 6.2, mat(0xe3e6ea, { roughness: 0.55, metalness: 0.15 }), 0.08);
  carga.position.set(0, 2.15, 1.1);
  g.add(carga);
  const matLlanta = mat(0xb8bfc7, { metalness: 0.75, roughness: 0.3 });
  for (const z of [-3.2, 1.6, 3.2]) for (const x of [-1.05, 1.05]) {
    const rueda = cilindro(0.48, 0.48, 0.35, mat(0x111214, { roughness: 0.9 }), 20);
    rueda.rotation.z = Math.PI / 2;
    rueda.position.set(x, 0.48, z);
    g.add(rueda);
    const llanta = cilindro(0.25, 0.25, 0.37, matLlanta, 16);
    llanta.rotation.z = Math.PI / 2;
    llanta.position.set(x, 0.48, z);
    g.add(llanta);
  }
  for (const x of [-0.8, 0.8]) {
    const faro = caja(0.35, 0.18, 0.05, mat(0xffffff, { emissive: 0xfff3d0, emissiveIntensity: 1.4 }), 0.02);
    faro.position.set(x, 1.25, -4.32);
    g.add(faro);
  }
  for (const x of [-1.0, 1.0]) {
    const trasera = caja(0.25, 0.15, 0.04, mat(0x400000, { emissive: 0xff2020, emissiveIntensity: 1.1 }), 0.02);
    trasera.position.set(x, 1.0, 4.22);
    g.add(trasera);
  }
  return g;
}

// ---------- Paso bajo nivel ----------
// La calle baja por una rampa, pasa por debajo de las vías y vuelve a subir.
// El agua se junta en la parte más baja; el semáforo está arriba, antes de la bajada.
const ANCHO = 9, FONDO = -5.6;
const Z_RAMPA = 26, Z_BAJO = 8; // la rampa baja entre z = 26 y z = 8, y sube igual del otro lado
const cota = z => {
  const a = Math.abs(z);
  if (a >= Z_RAMPA) return 0;
  if (a <= Z_BAJO) return FONDO;
  return FONDO * (Z_RAMPA - a) / (Z_RAMPA - Z_BAJO);
};
const paso = new THREE.Group();
const matHormigon = mat(0x8a9097, { roughness: 0.92, transparent: true });
const matAsfalto = mat(0x26292e, { roughness: 0.95, transparent: true });
const matLinea = new THREE.MeshBasicMaterial({ color: 0xeeeeee, transparent: true, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const matLineaAmarilla = new THREE.MeshBasicMaterial({ color: 0xe5b528, transparent: true,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const matLuz = new THREE.MeshBasicMaterial({ color: 0xfff1c9, transparent: true });
const matsPaso = [matHormigon, matAsfalto, matLinea, matLineaAmarilla, matLuz];

function tira(ancho, largo, segs, alto) { // plano a lo largo de z que sigue la cota
  const geo = new THREE.PlaneGeometry(ancho, largo, 1, segs);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, cota(p.getZ(i)) + alto);
  geo.computeVertexNormals();
  return geo;
}
const calle = new THREE.Mesh(tira(ANCHO, 2 * Z_RAMPA + 30, 164, 0), matAsfalto);
calle.receiveShadow = true;
paso.add(calle);
for (const x of [-ANCHO / 2 + 0.36, ANCHO / 2 - 0.36]) { // líneas continuas amarillas de borde
  const borde = new THREE.Mesh(tira(0.14, 2 * Z_RAMPA + 30, 164, 0.02), matLineaAmarilla);
  borde.position.x = x;
  paso.add(borde);
}
for (let z = -Z_RAMPA - 12; z < Z_RAMPA + 14; z += 3) { // líneas punteadas pegadas a la calle
  const geo = new THREE.PlaneGeometry(0.16, 1.4, 1, 7);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, z);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, cota(p.getZ(i)) + 0.02);
  paso.add(new THREE.Mesh(geo, matLinea));
}
for (const z of [16, 23]) for (const x of [-2, 2]) { // flechas de sentido en la rampa de entrada
  const asta = new THREE.PlaneGeometry(0.24, 1.4, 1, 6);
  asta.rotateX(-Math.PI / 2);
  asta.translate(x, 0, z);
  const p = asta.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, cota(p.getZ(i)) + 0.022);
  paso.add(new THREE.Mesh(asta, matLinea));
  const punta = new THREE.BufferGeometry();
  const zBase = z - 0.7, zPunta = z - 1.55;
  punta.setAttribute("position", new THREE.Float32BufferAttribute([
    x - 0.44, cota(zBase) + 0.022, zBase,
    x + 0.44, cota(zBase) + 0.022, zBase,
    x, cota(zPunta) + 0.022, zPunta,
  ], 3));
  paso.add(new THREE.Mesh(punta, matLinea));
}
// Rejillas transversales de desagüe pluvial en la parte baja
const matRejilla = mat(0x181b1f, { roughness: 0.6, metalness: 0.7, transparent: true });
matsPaso.push(matRejilla);
for (const z of [-Z_BAJO + 0.4, Z_BAJO - 0.4]) {
  const rej = caja(ANCHO - 0.5, 0.03, 0.42, matRejilla, 0.005);
  rej.position.set(0, FONDO + 0.012, z);
  paso.add(rej);
}
// Muros de contención a los costados de la rampa y del tramo bajo (de la calle hasta el nivel del suelo)
function muro(x) {
  const segs = 140, L = 2 * Z_RAMPA;
  const pos = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const z = -Z_RAMPA + (L * i) / segs;
    pos.push(x, cota(z), z, x, 0.35, z);
    if (i < segs) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, matHormigon);
  m.material.side = THREE.DoubleSide;
  m.receiveShadow = true;
  return m;
}
paso.add(muro(-ANCHO / 2), muro(ANCHO / 2));
// Reglas hidrométricas en ambas paredes del tramo bajo (muestran la altura del agua en metros)
{
  const c = document.createElement("canvas"); c.width = 128; c.height = 512;
  const x = c.getContext("2d");
  x.fillStyle = "#e8ecef"; x.fillRect(0, 0, 128, 512);
  x.fillStyle = "#d93838"; x.fillRect(0, 0, 26, 512 - Math.round(512 * 0.3 / 2.2)); // rojo desde 0,30 m
  x.fillStyle = "#1b1f24"; x.font = "bold 34px Arial, sans-serif"; x.textAlign = "right"; x.textBaseline = "middle";
  for (let dm = 0; dm <= 22; dm++) {
    const y = 512 - (dm / 22) * 492 - 10;
    const largo = dm % 5 === 0 ? 48 : 26;
    x.fillRect(26, y - 2, largo, dm % 5 === 0 ? 5 : 3);
    if (dm > 0 && dm % 5 === 0) x.fillText((dm / 10).toFixed(1).replace(".", ",") + "m", 122, y);
  }
  const texRegla = new THREE.CanvasTexture(c);
  texRegla.colorSpace = THREE.SRGBColorSpace;
  const matRegla = new THREE.MeshStandardMaterial({ map: texRegla, roughness: 0.7, transparent: true });
  matsPaso.push(matRegla);
  for (const [px, ry] of [[-ANCHO / 2 + 0.02, Math.PI / 2], [ANCHO / 2 - 0.02, -Math.PI / 2]]) {
    const r = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 2.2), matRegla);
    r.position.set(px, FONDO + 1.1, 5.8);
    r.rotation.y = ry;
    paso.add(r);
  }
}
for (const x of [-ANCHO / 2 - 0.2, ANCHO / 2 + 0.2]) { // baranda/cordón arriba del muro
  const c = caja(0.4, 0.3, 2 * Z_RAMPA, matHormigon, 0.05);
  c.position.set(x, 0.5, 0);
  paso.add(c);
}
// Losa del puente ferroviario: techo del túnel y frente (portal) donde va el cartel
const losa = caja(ANCHO + 3, 2.0, 2 * Z_BAJO, matHormigon, 0.05);
losa.position.set(0, -0.3, 0); // techo a y = -1.3
paso.add(losa);
// Franja cebrada de gálibo y señal de altura máxima (4,0 m) en el frente del puente
{
  const c = document.createElement("canvas"); c.width = 512; c.height = 64;
  const x = c.getContext("2d");
  x.fillStyle = "#eab01e"; x.fillRect(0, 0, 512, 64);
  x.fillStyle = "#15171a";
  for (let i = -64; i < 576; i += 48) {
    x.beginPath(); x.moveTo(i, 64); x.lineTo(i + 24, 64); x.lineTo(i + 56, 0); x.lineTo(i + 32, 0); x.closePath(); x.fill();
  }
  const texCebra = new THREE.CanvasTexture(c);
  texCebra.colorSpace = THREE.SRGBColorSpace;
  const matCebra = new THREE.MeshStandardMaterial({ map: texCebra, roughness: 0.6, transparent: true });
  matsPaso.push(matCebra);
  for (const [pz, ry] of [[Z_BAJO + 0.02, 0], [-Z_BAJO - 0.02, Math.PI]]) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(ANCHO + 0.4, 0.3), matCebra);
    f.position.set(0, -1.14, pz);
    f.rotation.y = ry;
    paso.add(f);
  }
  const cs = document.createElement("canvas"); cs.width = cs.height = 256;
  const xs = cs.getContext("2d");
  xs.fillStyle = "#f4f6f8"; xs.beginPath(); xs.arc(128, 128, 118, 0, Math.PI * 2); xs.fill();
  xs.lineWidth = 26; xs.strokeStyle = "#d9322a"; xs.stroke();
  xs.fillStyle = "#141619"; xs.font = "bold 78px Arial, sans-serif"; xs.textAlign = "center"; xs.textBaseline = "middle";
  xs.fillText("4,0m", 128, 132);
  const texAlt = new THREE.CanvasTexture(cs);
  texAlt.colorSpace = THREE.SRGBColorSpace;
  const matAlt = new THREE.MeshStandardMaterial({ map: texAlt, roughness: 0.45, transparent: true });
  matsPaso.push(matAlt);
  const discoAlt = new THREE.Mesh(new THREE.CircleGeometry(0.34, 32), matAlt);
  discoAlt.position.set(0, -0.45, Z_BAJO + 0.025);
  paso.add(discoAlt);
}
// Vías del tren y barandas sobre la losa, cruzando la calle
const ripio = caja(70, 0.35, 4.2, mat(0x5b5651, { roughness: 1, transparent: true }), 0.05);
ripio.position.set(0, 0.85, 0);
paso.add(ripio);
matsPaso.push(ripio.material);
const acero = mat(0x9aa1a8, { metalness: 0.8, roughness: 0.32, transparent: true });
matsPaso.push(acero);
for (const z of [-0.75, 0.75]) {
  const r = caja(70, 0.15, 0.12, acero, 0.02);
  r.position.set(0, 1.1, z);
  paso.add(r);
}
for (const z of [-Z_BAJO + 0.25, Z_BAJO - 0.25]) { // barandas metálicas del puente ferroviario
  for (const y of [1.15, 1.55]) {
    const pasamano = caja(ANCHO + 2.8, 0.06, 0.06, acero, 0.01);
    pasamano.position.set(0, y, z);
    paso.add(pasamano);
  }
  for (let x = -5.8; x <= 5.81; x += 1.45) {
    const posteB = caja(0.06, 0.9, 0.06, acero, 0.01);
    posteB.position.set(x, 1.15, z);
    paso.add(posteB);
  }
}
const madera = mat(0x4a3b2c, { roughness: 1, transparent: true });
matsPaso.push(madera);
for (let x = -34; x <= 34; x += 0.9) {
  const d = caja(0.28, 0.12, 2.4, madera, 0.02);
  d.position.set(x, 1.0, 0);
  paso.add(d);
}
// Luces del túnel
for (let z = -6; z <= 6; z += 3) {
  const l = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 0.3), matLuz);
  l.position.set(0, -1.33, z);
  paso.add(l);
  const p = new THREE.PointLight(0xffe2a8, 0, 8);
  p.position.set(0, -1.9, z);
  p.userData.luzTunel = true;
  paso.add(p);
}
paso.visible = false;
scene.add(paso);

// Suelo (alrededor de la zanja del paso bajo nivel) y veredas
const matSuelo = mat(0x26302a, { roughness: 1, transparent: true });
matsPaso.push(matSuelo);
for (const [w, d, x, z] of [[60, 140, -ANCHO / 2 - 30.4, 0], [60, 140, ANCHO / 2 + 30.4, 0],
  [ANCHO + 0.8, 44, 0, Z_RAMPA + 22], [ANCHO + 0.8, 44, 0, -Z_RAMPA - 22]]) {
  const s = new THREE.Mesh(new THREE.PlaneGeometry(w, d), matSuelo);
  s.rotation.x = -Math.PI / 2;
  s.position.set(x, -0.01, z);
  s.receiveShadow = true;
  paso.add(s);
}

// Gabinete instalado: en la pared izquierda, dentro del túnel, a media altura y por encima del agua
const Y_GAB = -2.9, Z_GAB = 3, ESC_GAB = 0.6;
const TOPE_GAB = Y_GAB + (GAB.W * ESC_GAB) / 2, PIE_GAB = Y_GAB - (GAB.W * ESC_GAB) / 2;

// Sensores ya instalados en el túnel
const instalados = new THREE.Group();
const conos = [];
const ALTO_CONO = -1.8 - FONDO;
for (const x of [-2, 2]) {
  const s = crearUltrasonico({ conPlaca: false });
  s.rotation.x = Math.PI / 2; // la sonda mira hacia abajo
  s.position.set(x, -1.6, 0);
  s.userData.escala = 0.7;
  instalados.add(s);
  const geoCono = new THREE.ConeGeometry(0.9, ALTO_CONO, 32, 1, true);
  geoCono.translate(0, -ALTO_CONO / 2, 0); // vértice en la sonda: al escalar se apoya sobre agua o camiones
  const matCono = new THREE.MeshBasicMaterial({ color: 0x5fb8ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
  const cono = new THREE.Mesh(geoCono, matCono);
  cono.position.set(x, -1.8, 0);
  const anillo = new THREE.Mesh(new THREE.RingGeometry(0.76, 0.9, 32), matCono);
  anillo.rotation.x = -Math.PI / 2;
  anillo.position.y = -ALTO_CONO + 0.02;
  cono.add(anillo);
  instalados.add(cono);
  conos.push(cono);
}
const aguaInstalado = crearSensorAgua();
aguaInstalado.position.set(-ANCHO / 2 + 0.25, FONDO + 0.7, Z_GAB);
aguaInstalado.userData.escala = 0.8;
instalados.add(aguaInstalado);
const sensoresInstalados = instalados.children.filter(o => !conos.includes(o));
sensoresInstalados.forEach(o => o.scale.setScalar(0.0001));
scene.add(instalados);

// Caños por donde van los cables de los tres sensores hasta el gabinete
const matCano = mat(0x9ea5ad, { roughness: 0.45, metalness: 0.55, transparent: true, opacity: 0 });
function cano(puntos) {
  const g = new THREE.Group();
  for (let i = 0; i < puntos.length - 1; i++) {
    const a = new THREE.Vector3(...puntos[i]), b = new THREE.Vector3(...puntos[i + 1]);
    const tramo = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, a.distanceTo(b), 12), matCano);
    tramo.position.copy(a).add(b).multiplyScalar(0.5);
    tramo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.add(tramo);
    if (i > 0) {
      const codo = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 8), matCano);
      codo.position.copy(a);
      g.add(codo);
    }
  }
  const prensa = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.1, 6), matCano);
  prensa.position.set(...puntos[puntos.length - 1]);
  g.add(prensa);
  return g;
}
const XP = -ANCHO / 2 + 0.12, YT = -1.42; // caños pegados a la pared y al techo
const canos = new THREE.Group();
canos.add(
  cano([[-2, YT, 0], [-2, YT, Z_GAB - 0.15], [XP, YT, Z_GAB - 0.15], [XP, TOPE_GAB, Z_GAB - 0.15]]),
  cano([[2, YT, 0], [2, YT, Z_GAB + 0.15], [XP, YT, Z_GAB + 0.15], [XP, TOPE_GAB, Z_GAB + 0.15]]),
  cano([[-ANCHO / 2 + 0.2, FONDO + 1.45, Z_GAB], [-ANCHO / 2 + 0.2, PIE_GAB, Z_GAB]]),
);
canos.visible = false;
scene.add(canos);

// ---------- Semáforo (arriba, antes de la bajada) y cartel (en el frente del túnel) ----------
const semaforo = new THREE.Group();
{
  const basePoste = cilindro(0.22, 0.26, 0.18, mat(0x3a4048, { metalness: 0.6, roughness: 0.4 }), 16);
  basePoste.position.y = 0.09;
  semaforo.add(basePoste);
  const poste = cilindro(0.1, 0.12, 4.2, mat(0x4a5058, { metalness: 0.65, roughness: 0.35 }));
  poste.position.y = 2.1;
  semaforo.add(poste);
  const orla = caja(0.82, 2.02, 0.04, mat(0xdce2e8, { roughness: 0.5 }), 0.09);
  orla.position.set(0, 4.9, -0.02);
  semaforo.add(orla);
  const cuerpo = caja(0.7, 1.9, 0.5, mat(0x1b1e23, { roughness: 0.5 }), 0.08);
  cuerpo.position.y = 4.9;
  semaforo.add(cuerpo);
}
const texHalo = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const luces = {}, halos = [];
[["rojo", 0xff2a1f, 5.48], ["amarillo", 0xffa000, 4.9], ["verde", 0x1fd65a, 4.32]].forEach(([n, c, y]) => {
  const m = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: c, emissiveIntensity: 0.06, roughness: 0.25 });
  const l = new THREE.Mesh(new THREE.CircleGeometry(0.2, 32), m);
  l.position.set(0, y, 0.255);
  semaforo.add(l);
  const visera = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.22, 24, 1, true, -Math.PI * 0.38, Math.PI * 0.76),
    mat(0x15171a, { side: THREE.DoubleSide, roughness: 0.5 }));
  visera.rotation.x = Math.PI / 2;
  visera.rotation.z = Math.PI / 2;
  visera.position.set(0, y + 0.02, 0.34);
  semaforo.add(visera);
  const haloMat = new THREE.SpriteMaterial({ map: texHalo, color: c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
  const halo = new THREE.Sprite(haloMat);
  halo.position.set(0, y, 0.32);
  halo.scale.setScalar(1.45);
  semaforo.add(halo);
  halos.push([haloMat, m]);
  luces[n] = m;
});
semaforo.position.set(ANCHO / 2 + 1.0, 0, Z_RAMPA + 1.5);
semaforo.userData.escala = 1;
semaforo.scale.setScalar(0.0001);
scene.add(semaforo);

function texturaCartel(l1, l2) {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 360;
  const x = c.getContext("2d");
  x.fillStyle = "#050505"; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = "#ffb52e";
  x.shadowColor = "#ff9500"; x.shadowBlur = 10;
  x.font = "bold 118px Consolas, monospace";
  x.textAlign = "center"; x.textBaseline = "middle";
  // Achica la letra si el renglón más largo no entra en el ancho del cartel
  const ancho = Math.max(x.measureText(l1).width, l2 ? x.measureText(l2).width : 0);
  if (ancho > 940) x.font = `bold ${Math.floor(118 * 940 / ancho)}px Consolas, monospace`;
  if (l2) { x.fillText(l1, 512, 110); x.fillText(l2, 512, 250); } else { x.fillText(l1, 512, 180); }
  x.shadowBlur = 0;
  x.fillStyle = "rgba(5,5,5,0.82)";
  for (let i = 0; i < c.width; i += 9) x.fillRect(i, 0, 3, c.height);
  for (let j = 0; j < c.height; j += 9) x.fillRect(0, j, c.width, 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const cartel = new THREE.Group();
cartel.add(caja(4.7, 1.6, 0.25, mat(0x15171a, { roughness: 0.45, metalness: 0.3 }), 0.04));
{
  const viseraCartel = caja(4.78, 0.08, 0.4, mat(0x15171a, { roughness: 0.5, metalness: 0.3 }), 0.02);
  viseraCartel.position.set(0, 0.82, 0.06);
  cartel.add(viseraCartel);
  const matSoporte = mat(0x3a4048, { metalness: 0.7, roughness: 0.35 });
  for (const x of [-1.85, 1.85]) {
    const col = caja(0.16, 1.1, 0.18, matSoporte, 0.02);
    col.position.set(x, -0.42, -0.14);
    cartel.add(col);
  }
}
const caras = [["PASO HABILITADO", ""], ["PRECAUCION", "POSIBLE INUNDACION"], ["PASO CERRADO", "AGUA CRITICA"],
  ["PRECAUCION", "CARRIL BLOQUEADO"], ["PASO CERRADO", "AMBOS BLOQUEADOS"]]
  .map(([a, b], i) => {
    const m = new THREE.MeshBasicMaterial({ map: texturaCartel(a, b), transparent: true, opacity: i === 0 ? 1 : 0 });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 1.45), m);
    p.position.z = 0.13 + i * 0.002;
    cartel.add(p);
    return m;
  });
cartel.position.set(0, 0.9, Z_BAJO + 0.15); // sobre la boca del túnel, asoma por encima del nivel de la calle
cartel.userData.escala = 1;
cartel.scale.setScalar(0.0001);
scene.add(cartel);

// ---------- Escenario de presentación de piezas ----------
const Z_ESC = 46;
const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.6, 0.25, 64), mat(0x1b2027, { roughness: 0.45, metalness: 0.3 }));
pedestal.position.set(0, 0.12, Z_ESC + 0.3);
pedestal.receiveShadow = true;
{
  const aro = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.022, 12, 64),
    mat(0x4fc3f7, { emissive: 0x4fc3f7, emissiveIntensity: 0.45, roughness: 0.3 }));
  aro.rotation.x = Math.PI / 2;
  aro.position.y = 0.125;
  pedestal.add(aro);
}
scene.add(pedestal);
const foco = new THREE.SpotLight(0xffffff, 70, 15, 0.6, 0.5);
foco.position.set(0, 7.5, Z_ESC + 2.5);
foco.target.position.set(0, 0.5, Z_ESC);
foco.castShadow = true;
foco.shadow.mapSize.set(1024, 1024);
foco.shadow.bias = -0.0005;
scene.add(foco, foco.target);

const esp32 = crearESP32();
const ultra1 = crearUltrasonico(); const ultra2 = crearUltrasonico();
const agua = crearSensorAgua();
const gabinete = crearGabinete();
const escenario = [esp32, ultra1, ultra2, agua];
esp32.position.set(0, 0.7, Z_ESC + 0.9);
esp32.userData.escalaVista = 0.8;
ultra1.position.set(-2.3, 1.35, Z_ESC - 0.9);
ultra2.position.set(2.3, 1.35, Z_ESC - 0.9);
agua.position.set(0, 1.0, Z_ESC - 1.4);
gabinete.position.set(0, 0.25, Z_ESC);
[...escenario, gabinete].forEach(o => { o.userData.escala = 1; o.scale.setScalar(0.0001); scene.add(o); });

// ---------- Lluvia y agua ----------
// Textura periódica liviana (128 × 128) para ondular la superficie del agua sin costo en GPU integrada.
const texAgua = (() => {
  const n = 128, c = document.createElement("canvas");
  c.width = c.height = n;
  const x = c.getContext("2d"), img = x.createImageData(n, n), d = img.data, k = (Math.PI * 2) / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = 128 + 55 * Math.sin(i * k * 3 + j * k) + 40 * Math.cos(j * k * 4 - i * k * 2) + 25 * Math.sin((i + j) * k * 6);
    const p = (j * n + i) * 4;
    d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 14);
  return t;
})();
// El agua es una caja con base en el fondo: donde la rampa queda por encima, la calle la tapa.
const geoAgua = new THREE.BoxGeometry(ANCHO - 0.02, 1, 2 * Z_RAMPA - 4);
geoAgua.translate(0, 0.5, 0);
const aguaTunel = new THREE.Mesh(geoAgua, new THREE.MeshStandardMaterial({
  color: 0x2b76ad, transparent: true, opacity: 0, roughness: 0.14, metalness: 0.35,
  bumpMap: texAgua, bumpScale: 0.035 }));
aguaTunel.position.y = FONDO + 0.01;
aguaTunel.visible = false; // invisible mientras no hay agua: si no, pelea con la calle y aparecen rayas
aguaTunel.scale.y = 0.0001;
scene.add(aguaTunel);

matsPaso.forEach(m => { m.opacity = 0; });

const camion1 = crearCamion(0xc8452f); // carril derecho, baja hacia el túnel
camion1.position.set(2, 0, 50);
const camion2 = crearCamion(0x2f6fc8); // carril izquierdo, mismo sentido que el primero
camion2.position.set(-2, 0, 58);
// Sigue la calle: altura y pendiente según dónde está
const ubicar = c => {
  const z = c.position.z;
  c.position.y = cota(z);
  c.rotation.x = -Math.atan2(cota(z + 1) - cota(z - 1), 2);
};
[camion1, camion2].forEach(c => { c.visible = false; ubicar(c); scene.add(c); });
const luzTunel = { v: 0 };
const giro = { v: 1 };

