import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { MixerEngine } from './audio.js';
import { SpectrogramTerrain } from './spectrogram.js';
import { bindUI } from './ui.js';

const canvas = document.getElementById('scene');
const audioElA = document.getElementById('audio');
const audioElB = document.getElementById('audio-b');

// ---- Spectrogram time window ----
// Decouple ingest rate from display rate so the visible window length is predictable.
const INGEST_HZ = 30;                 // analyser frames pushed per second
const HISTORY_SECONDS = 13;           // how much time should fit on the terrain
const TIME_SLICES = Math.round(INGEST_HZ * HISTORY_SECONDS); // 390
const TERRAIN_DEPTH = 22;
const TERRAIN_WIDTH = 24;

// ---- Renderer / scene ----
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

// HTML overlay renderer for axis labels
const labelRenderer = new CSS2DRenderer({ element: document.getElementById('labels-root') });
labelRenderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
scene.fog = new THREE.Fog(0x05060a, 30, 80);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  300
);
camera.position.set(0, 11, 26);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 1, 0);
controls.autoRotate = true;
controls.autoRotateSpeed = 0.4;
controls.minDistance = 6;
controls.maxDistance = 80;
controls.maxPolarAngle = Math.PI * 0.49;
controls.addEventListener('start', () => { controls.autoRotate = false; });

// Lighting (mostly aesthetic — terrain uses MeshBasicMaterial)
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(8, 12, 6);
scene.add(dir);

// Subtle ground grid for depth cue
const grid = new THREE.GridHelper(80, 40, 0x223044, 0x111822);
grid.position.y = -0.01;
scene.add(grid);

// ---- Audio + spectrogram ----
const mixer = new MixerEngine({ audioElA, audioElB });
mixer.setFftSize(2048);
mixer.setSmoothing(0.7);

const baseTerrainOpts = {
  freqBins: 192,
  timeSlices: TIME_SLICES,
  width: TERRAIN_WIDTH,
  depth: TERRAIN_DEPTH,
  maxHeight: 3.5,
};

// Heatmap terrain — driven by the post-mix analyser (what you actually hear)
const terrain = new SpectrogramTerrain(baseTerrainOpts);
scene.add(terrain.mesh);

// Wireframe shadow per track — driven by each track's pre-gain analyser,
// so it stays at full intensity regardless of crossfader position. Each track
// gets its own colormap so the two shadows are visually distinct.
const shadowA = new SpectrogramTerrain({
  ...baseTerrainOpts,
  style: 'shadow',
  colormap: 'cool',
  yOffset: 0.02,
});
const shadowB = new SpectrogramTerrain({
  ...baseTerrainOpts,
  style: 'shadow',
  colormap: 'warm',
  yOffset: 0.04,
});
shadowA.mesh.visible = false;
shadowB.mesh.visible = false;
scene.add(shadowA.mesh);
scene.add(shadowB.mesh);

// ---- Playhead marker ("NOW" line) at the front edge of the terrain ----
const playheadGroup = new THREE.Group();
{
  // Bright ribbon at z = +depth/2 (front, newest data)
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(TERRAIN_WIDTH + 0.6, 0.1, 0.18),
    new THREE.MeshBasicMaterial({ color: 0x6cf3ff, transparent: true, opacity: 0.95 })
  );
  bar.position.set(0, 0.05, TERRAIN_DEPTH / 2 + 0.04);
  playheadGroup.add(bar);

  // Soft glow underlay
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(TERRAIN_WIDTH + 1.2, 0.6),
    new THREE.MeshBasicMaterial({
      color: 0x6cf3ff,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(0, 0.005, TERRAIN_DEPTH / 2 + 0.04);
  playheadGroup.add(glow);
}
scene.add(playheadGroup);

// ---- Axis labels (CSS2D HTML overlay) ----
function makeLabel(text, classes = '') {
  const el = document.createElement('div');
  el.className = `axis-label ${classes}`.trim();
  el.textContent = text;
  return new CSS2DObject(el);
}

{
  const halfW = TERRAIN_WIDTH / 2;
  const front = TERRAIN_DEPTH / 2;
  const slicesPerSec = INGEST_HZ;
  const sliceStep = TERRAIN_DEPTH / (TIME_SLICES - 1);

  // Frequency labels: log-spaced, placed just in front of the playhead
  const fMin = 20;
  const fMax = 20000;
  const logMin = Math.log(fMin);
  const logMax = Math.log(fMax);
  const freqStops = [
    { hz:    50, text:  '50' },
    { hz:   100, text: '100' },
    { hz:   200, text: '200' },
    { hz:   500, text: '500' },
    { hz:  1000, text: '1k',  major: true },
    { hz:  2000, text: '2k' },
    { hz:  5000, text: '5k' },
    { hz: 10000, text: '10k', major: true },
    { hz: 20000, text: '20k' },
  ];
  for (const f of freqStops) {
    const t = (Math.log(f.hz) - logMin) / (logMax - logMin);
    const x = (t - 0.5) * TERRAIN_WIDTH;
    const lbl = makeLabel(f.text, f.major ? 'major' : '');
    lbl.position.set(x, 0.08, front + 0.7);
    scene.add(lbl);
  }

  // Time labels along the left edge: -1s, -2s, -5s, -10s, plus "now"
  const timeStops = [
    { sec:  0, text: 'now', cls: 'now' },
    { sec:  1, text: '−1s' },
    { sec:  2, text: '−2s' },
    { sec:  5, text: '−5s', cls: 'major' },
    { sec: 10, text: '−10s', cls: 'major' },
  ];
  for (const t of timeStops) {
    const z = front - t.sec * slicesPerSec * sliceStep;
    const lbl = makeLabel(t.text, t.cls || '');
    lbl.position.set(-halfW - 0.7, 0.08, z);
    scene.add(lbl);
  }
}

// ---- Time tick marks behind the playhead (every second, brighter every 5s) ----
{
  const tickMaterial = new THREE.LineBasicMaterial({ color: 0x3a4d6a, transparent: true, opacity: 0.55 });
  const tickMaterialMajor = new THREE.LineBasicMaterial({ color: 0x6280a0, transparent: true, opacity: 0.85 });
  const halfW = TERRAIN_WIDTH / 2 + 0.3;
  const slicesPerSec = INGEST_HZ;
  const sliceStep = TERRAIN_DEPTH / (TIME_SLICES - 1);
  const front = TERRAIN_DEPTH / 2;
  const totalSecs = Math.floor(HISTORY_SECONDS);
  for (let s = 1; s <= totalSecs; s++) {
    const z = front - s * slicesPerSec * sliceStep;
    const major = s % 5 === 0;
    const geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-halfW, 0.002, z),
      new THREE.Vector3( halfW, 0.002, z),
    ]);
    scene.add(new THREE.Line(geom, major ? tickMaterialMajor : tickMaterial));
  }
}

bindUI({
  mixer,
  onMixModeChange: (on) => {
    shadowA.mesh.visible = on;
    shadowB.mesh.visible = on;
  },
});

// ---- Render loop ----
const INGEST_INTERVAL = 1 / INGEST_HZ;
let ingestAccum = 0;
let lastTime = performance.now() / 1000;

function tick() {
  const now = performance.now() / 1000;
  const dt = Math.min(0.1, now - lastTime); // clamp big gaps (tab background)
  lastTime = now;

  if (mixer.anyPlaying) {
    ingestAccum += dt;
    // Push at most a few frames per render to catch up after a stall, but don't spin
    let pushes = 0;
    const sr = mixer.sampleRate;
    while (ingestAccum >= INGEST_INTERVAL && pushes < 4) {
      terrain.pushFrame(mixer.getMixFrequencyData(), sr);
      // Each shadow uses its own analyser if the track is playing; otherwise
      // push silence so all three terrains stay aligned in time.
      if (!mixer.trackA.paused) shadowA.pushFrame(mixer.trackA.getFrequencyData(), sr);
      else shadowA.pushSilent();
      if (!mixer.trackB.paused) shadowB.pushFrame(mixer.trackB.getFrequencyData(), sr);
      else shadowB.pushSilent();
      ingestAccum -= INGEST_INTERVAL;
      pushes++;
    }
    if (ingestAccum > INGEST_INTERVAL) ingestAccum = INGEST_INTERVAL; // drop excess
  } else {
    ingestAccum = 0;
  }

  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---- Resize ----
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
});
