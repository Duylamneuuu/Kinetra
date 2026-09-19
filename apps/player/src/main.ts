import * as THREE from "three";

import "./style.css";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
const status = document.querySelector<HTMLSpanElement>("#status");
const fullscreenButton = document.querySelector<HTMLButtonElement>("#fullscreen");

if (!canvas || !status || !fullscreenButton) {
  throw new Error("Kinetra player bootstrap DOM is incomplete");
}

const statusElement = status;

// This raw scene exists only to prove the desktop packaging path.
// Game authoring remains command/project-model driven; P2+ will feed runtime scenes here.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color("#0b0d12");

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.position.set(4, 3, 6);
camera.lookAt(0, 0.5, 0);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: "#d9e6ff", roughness: 0.45, metalness: 0.1 }),
);
cube.position.y = 0.5;
scene.add(cube);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(12, 12),
  new THREE.MeshStandardMaterial({ color: "#1b2230", roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const key = new THREE.DirectionalLight("#ffffff", 3);
key.position.set(4, 6, 3);
scene.add(key);
scene.add(new THREE.AmbientLight("#6f89b8", 0.8));

function resize(): void {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

window.addEventListener("resize", resize);
resize();

const startedAt = performance.now();

function frame(now: number): void {
  cube.rotation.y = (now - startedAt) * 0.00045;
  cube.rotation.x = Math.sin((now - startedAt) * 0.0003) * 0.12;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

async function updatePlatformStatus(): Promise<void> {
  if (!window.kinetraPlatform) {
    statusElement.textContent = "browser runtime";
    return;
  }

  const [state, saveRoot] = await Promise.all([
    window.kinetraPlatform.getWindowState(),
    window.kinetraPlatform.getUserDataPath(),
  ]);

  statusElement.textContent = `desktop · ${state.fullscreen ? "fullscreen" : "windowed"} · save root: ${saveRoot}`;
}

fullscreenButton.addEventListener("click", async () => {
  if (!window.kinetraPlatform) {
    await document.documentElement.requestFullscreen();
    return;
  }

  const state = await window.kinetraPlatform.getWindowState();
  await window.kinetraPlatform.setFullscreen(!state.fullscreen);
  await updatePlatformStatus();
});

void updatePlatformStatus();
