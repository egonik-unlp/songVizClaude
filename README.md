# 3D Song Visualizer

Drop in an audio file, watch a scrolling 3-D spectrogram terrain in your browser.

## What it does

- **Log-frequency 3-D terrain.** Bass on the left, treble on the right, time scrolling toward you, amplitude as height + heatmap color.
- **Drag-and-drop loading.** Drop any MP3 / WAV / OGG / FLAC / M4A that your browser can decode.
- **Mix mode.** Load a second track in parallel. Each track gets its own 3-band EQ and a translucent wireframe "shadow" with its own colormap. The colored heatmap underneath is the actual audible mix.
- **Axis labels & playhead.** Frequencies labeled in Hz / kHz at the front edge, time labeled in seconds-ago down the left edge, with a cyan "NOW" bar where new audio enters.
- **Cinematic camera with click-to-control.** Auto-rotates on load; OrbitControls take over the moment you grab the canvas.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173 (or :5174 if 5173 is busy)
npm run build        # production bundle in dist/
npm run preview      # serve the built bundle locally
```

Open the dev URL, drop a song onto the overlay, and the visualization starts.

## Or run with Docker

```bash
docker build -t songviz .
docker run --rm -p 8080:80 songviz
```

Then open http://localhost:8080.

The image is a two-stage build (Node for the Vite build, Nginx for serving the static bundle). Final image is small (under ~60 MB).

## Usage

### Loading audio
- **Drop overlay** (shown until the first file is loaded): drag a file in, or click to open a file picker.
- After load, drag-and-drop anywhere in the window to replace the current Track A.

### Camera
- **Left-drag** — rotate
- **Scroll** — zoom (clamped 6 … 80 units)
- **Right-drag** — pan
- **Auto-rotate** runs until the first user interaction with the camera, then stays under user control.

### Bottom transport (master)
- Master **play / pause** — toggles every loaded track together.
- Master **seek** — scrubs all loaded tracks to the same absolute time (each clamped to its own duration).
- Master **time label** — follows the longer-duration loaded track.

### Settings (gear, top-right)
- **FFT size** — 256 … 8192. Reallocates the analyser buffer. Visual frequency resolution is mostly decoupled from FFT size thanks to log-binning, but higher values give smoother detail in the highs.
- **Smoothing** — `AnalyserNode.smoothingTimeConstant` from 0 (twitchy) to 0.99 (very flowy).
- **Mix mode** — see below.

## Mix mode

Toggle it from the gear menu. The mix sub-panel reveals two track rows, each with:

- **Load button + filename + per-track play/seek/time.**
- **3-band EQ**: L (250 Hz low-shelf) · M (1 kHz peaking, Q=1) · H (4 kHz high-shelf). Each slider is in dB, range **−18 dB … +6 dB**, center is flat.
- **Crossfader (A ↔ B)**: equal-power, defaults to center so loading Track B is immediately audible alongside A. Moving the crossfader does NOT change the wireframe shadows — only the audible mix.

The two **wireframe shadows** use distinct colormaps so you can always tell which track is which:

- **Track A** — cool palette: dim teal at zero amplitude, blue → cyan → near-white at peaks.
- **Track B** — warm palette: dim wine at zero, red-orange → orange → yellow at peaks.

Shadows tap **post-EQ** but **pre-fader** in the audio graph — so EQ changes do show in the shadow, but a track that's currently silent in the mix (crossfader pulled all the way away from it) still casts a visible shadow.

## Project layout

```
.
├── index.html          # canvas + UI markup + audio elements
├── vite.config.js
├── package.json
├── Dockerfile          # multi-stage Node build → Nginx static serve
├── .dockerignore
├── README.md
├── ARCHITECTURE.md     # developer-oriented design doc
└── src/
    ├── main.js         # scene/camera/renderer; ingest loop; axis labels & ticks
    ├── audio.js        # MixerEngine + Track (Web Audio graph, EQ, crossfader)
    ├── spectrogram.js  # SpectrogramTerrain + colormaps (ring buffer + Three.js mesh)
    ├── ui.js           # drop overlay, transports, EQ sliders, mix toggle
    └── style.css
```

## Tech stack

- **[Vite](https://vitejs.dev/)** for dev server + production bundling
- **[Three.js](https://threejs.org/)** for WebGL (PerspectiveCamera + OrbitControls + CSS2DRenderer for HTML axis labels)
- **Web Audio API** for decoding, mixing, EQ (`BiquadFilterNode`), and analysis (`AnalyserNode`)
- Vanilla JS — no framework

## Browser support

Modern evergreen browsers (Chrome, Firefox, Safari, Edge) with Web Audio + WebGL2. The `MediaElementAudioSourceNode` route used here means CORS doesn't apply to local file loads via object URLs.

## See also

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — audio routing diagram, render pipeline, module responsibilities, design rationale.
