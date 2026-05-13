# Architecture

This document explains how the 3D Song Visualizer is wired internally. For end-user docs, see [`README.md`](./README.md).

## Overview

A WebGL terrain (Three.js `PlaneGeometry`) is updated every frame from a Web Audio `AnalyserNode.getByteFrequencyData()` reading. Each row of vertices represents one historical time slice; the row at the front of the terrain (closest to the camera) is the newest. Vertex Y (height) and per-vertex RGB are written from a colormap LUT. An HTML overlay (Three.js `CSS2DRenderer`) provides crisp axis labels.

Three terrains exist in mix mode:

| Layer       | Source                  | Material                                  | Purpose                         |
|-------------|-------------------------|-------------------------------------------|---------------------------------|
| Heatmap     | `mixAnalyser` (post-mix)| Solid surface, `heatmap` colormap         | What you actually hear          |
| Shadow A    | `analyserA` (post-EQ pre-gain) | Wireframe, `cool` colormap         | Track A's signal, always visible|
| Shadow B    | `analyserB` (post-EQ pre-gain) | Wireframe, `warm` colormap         | Track B's signal, always visible|

All three share `width / depth / freqBins / timeSlices` so they line up exactly; each shadow gets a small `yOffset` to avoid z-fighting with the heatmap and each other.

## Module map

| File                          | Responsibility |
|-------------------------------|----------------|
| `src/main.js`                 | Scene / camera / renderer bootstrap, ingest loop, axis labels and ticks, playhead bar, wiring between `MixerEngine` and the three `SpectrogramTerrain`s. |
| `src/audio.js`                | `MixerEngine` (top-level audio + crossfader) and `Track` (per-track audio graph: source → 3-band EQ → analyser → gain → mix bus). |
| `src/spectrogram.js`          | `SpectrogramTerrain` (ring buffer + Three.js mesh + log-frequency binning + per-vertex colormap update) and the named `COLORMAPS` table. |
| `src/ui.js`                   | Drop overlay, settings panel, master transport, per-track transports + EQ sliders, mix-mode toggle, drag-and-drop handling. |
| `index.html`, `src/style.css` | DOM scaffolding and styling (settings, transport, mix panel, axis labels, drop overlay). |

## Audio graph

```
Track A:  audioElA → sourceA → lowA → midA → highA ┬→ analyserA   (shadow A, post-EQ pre-gain)
                                                   └→ gainA ─┐
Track B:  audioElB → sourceB → lowB → midB → highB ┬→ analyserB
                                                   └→ gainB ─┤
                                                             ▼
                                                       mixBus → mixAnalyser → destination
```

### Why the per-track analyser is **post-EQ but pre-gain**

- **Post-EQ**: pulling a band down on Track A makes that band disappear from Track A's wireframe shadow — the shadow reflects intentional tonal shaping.
- **Pre-gain**: the analyser is wired *before* the crossfader gain, so even a track that is currently muted in the mix (crossfader pulled all the way to the other side) still produces a full-amplitude shadow. Empty crossfader ≠ empty visualization.

### EQ design

Three `BiquadFilterNode`s in series per track:

| Band | Filter type   | Frequency | Q   |
|------|---------------|-----------|-----|
| Low  | `lowshelf`    | 250 Hz    | —   |
| Mid  | `peaking`     | 1 kHz     | 1   |
| High | `highshelf`   | 4 kHz     | —   |

Each band's `gain` is a dB value. UI slider range is **−18 dB … +6 dB**, default 0 dB (flat). The shelving topology is the conventional choice for a 3-band tone shaper — much cheaper and less surgical than a parametric EQ, but exactly right for tasteful mixing.

### Crossfader

Equal-power blend, `t ∈ [0, 1]`:

```
gainA.gain.value = Math.cos(t * Math.PI / 2)
gainB.gain.value = Math.sin(t * Math.PI / 2)
```

Default `t = 0.5` → ~0.707 each → constant total perceived power. At `t = 0` you hear only A, at `t = 1` only B.

## Spectrogram pipeline

### Log-frequency bucketing

`AnalyserNode.getByteFrequencyData()` returns bins linearly spaced from 0 to `sampleRate / 2`. For music that's almost entirely useless — at 44.1 kHz, the bottom octave (20–40 Hz) is ~2 bins out of 1024, and the entire mid+treble range above 4 kHz takes ~80 % of the buffer.

`SpectrogramTerrain._logBin()` collapses those linear bins into `freqBins` log-spaced buckets covering 20 Hz – 20 kHz, averaging the linear bins that fall into each log bucket. Result: bass and treble each get a fair share of the X axis, which is what your eye expects in a "musical" spectrogram.

### Ring buffer

```
this.history = new Float32Array(timeSlices * freqBins);
this.headRow = 0;
```

`pushFrame()` writes a new row at `headRow`, then advances. Geometry row `r` reads from history row `(headRow + r) mod timeSlices`, which means row `r = timeSlices - 1` (front of terrain, closest to camera) always contains the newest data.

### Per-frame mesh update

For each vertex in the terrain (`freqBins × timeSlices` vertices total):

- `positions[vertexIdx + 2] = amplitude * maxHeight` — height
- `colors[vertexIdx + 0..2] = LUT[amplitude]` — RGB from the active colormap

Then mark `geometry.attributes.position.needsUpdate = true` and the same for `color`. At 192 × 220 ≈ 42k vertices and 30 ingest pushes/sec, this is comfortably below GPU budget on any modern device.

**Upgrade path** (if you ever push it harder): move the height to a data-texture sampled in a custom vertex shader; that lets you scale to many more time slices without paying the per-vertex CPU update cost.

### Colormaps

Defined in `COLORMAPS` (`src/spectrogram.js`) as named lists of `[t, [r, g, b]]` stops. `buildLUT(stops)` interpolates 256 entries.

| Name      | Use            | Palette                                       |
|-----------|----------------|-----------------------------------------------|
| `heatmap` | Mix surface    | Deep navy-violet → purple → rose → orange → amber → pale yellow |
| `cool`    | Track A shadow | Dim teal → blue → cyan → near-white           |
| `warm`    | Track B shadow | Dim wine → red-orange → orange → yellow       |

To add a colormap: append a key to `COLORMAPS` and pass `colormap: 'yourName'` (or a stops array) when constructing a `SpectrogramTerrain`.

## Time axis

### Ingest is decoupled from display

```js
const INGEST_HZ = 30;
const HISTORY_SECONDS = 13;
const TIME_SLICES = INGEST_HZ * HISTORY_SECONDS;   // 390
```

In `main.js`, the `tick()` function uses a frame-time accumulator to call `pushFrame()` at a steady ~30 Hz regardless of display rate. Without this, the visible window length would vary by GPU speed and frame rate.

### Labels & ticks

Frequency labels (Hz / kHz) are placed at the front edge of the terrain at log-spaced X positions. Time labels (`now`, `−1s`, `−2s`, `−5s`, `−10s`) and the per-second tick lines are placed at Z positions computed from `INGEST_HZ * sliceStep`, so they always agree with the data. The cyan **playhead bar** sits at `z = +depth/2`, marking where new audio enters.

## Three terrains, layered

| Layer      | `style`     | `colormap` | `yOffset` |
|------------|-------------|------------|-----------|
| Heatmap    | `'heatmap'` | `'heatmap'`| 0.00      |
| Shadow A   | `'shadow'`  | `'cool'`   | 0.02      |
| Shadow B   | `'shadow'`  | `'warm'`   | 0.04      |

`yOffset` is a small vertical lift on each shadow so wireframes don't z-fight with the heatmap surface or each other. The shadow meshes are hidden until mix mode is toggled on.

## Master vs per-track transport

- **Master** (`#transport` at the bottom of the page): iterates over `mixer.tracks.filter(t => t.hasFile)` for play/pause/seek. Seek sets absolute `currentTime` on each (browser clamps per-track at end). Master display uses the longer-duration loaded track as the canonical timeline source.
- **Per-track** (inside the mix panel): independent play/pause/seek per track, used for deliberate alignment (e.g., starting Track B 5 seconds into its file).

The two transports are intentionally not exclusive — the master is for "control the whole mix," the per-track is for fine alignment.

## Camera & interaction

`PerspectiveCamera` at `(0, 11, 26)` looking at the origin. `OrbitControls` with:

- `enableDamping = true` for smooth inertia
- `autoRotate = true` (slow, 0.4°/frame) until the `start` event fires from a user gesture; then auto-rotate is turned off and the user has control.
- Clamped distances `[6, 80]` so you can't zoom inside the terrain or fly into space.
- `maxPolarAngle = π/2 * 0.49` so the camera can't dip below the ground plane.

## Performance notes & extension hooks

- **Vertex update** is the hot path. At ~42k vertices per terrain × 3 terrains × 30 Hz = ~3.8M attribute writes / sec. Trivial on any modern GPU; if you scale further, swap the position update for a data-texture displacement shader.
- **Adding a third track**: extend `MixerEngine.tracks` and add another `SpectrogramTerrain` with a new colormap. The ingest loop already iterates over `mixer.tracks`.
- **Adding more EQ bands**: extend `Track.eq` with more `BiquadFilterNode`s in the chain, expose them in the UI markup, and wire to `setEqGain(band, db)`.
- **Adding a colormap**: append a key to `COLORMAPS` in `src/spectrogram.js`. Pass `colormap: 'yourName'` when constructing the terrain.

## Build & deploy

- `npm run build` produces a fully static bundle in `dist/`.
- The provided `Dockerfile` builds that bundle and serves it with Nginx — small (<60 MB) and self-contained.
