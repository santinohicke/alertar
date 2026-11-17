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

