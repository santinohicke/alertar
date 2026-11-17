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

