import * as THREE from 'three';

// Each colormap is a list of [t, [r,g,b]] stops with t in [0,1].
export const COLORMAPS = {
  // Mix terrain — sunset-inspired heatmap.
  heatmap: [
    [0.00, [  4,   4,  18]],
    [0.18, [ 32,  14,  58]],
    [0.36, [ 96,  24,  78]],
    [0.55, [178,  38,  66]],
    [0.74, [226,  74,  38]],
    [0.90, [244, 142,  48]],
    [1.00, [255, 188,  92]],
  ],
  // Track A shadow — cool blues/cyans. Lowest stop is dim but visible so the
  // wireframe is still perceptible when the track is silent.
  cool: [
    [0.00, [ 25,  55,  90]],
    [0.30, [ 40, 130, 220]],
    [0.60, [ 80, 220, 240]],
    [0.85, [180, 250, 250]],
    [1.00, [240, 255, 255]],
  ],
  // Track B shadow — warm reds/oranges/yellows.
  warm: [
    [0.00, [ 80,  30,  30]],
    [0.30, [220,  80,  30]],
    [0.60, [240, 160,  50]],
    [0.85, [250, 230, 100]],
    [1.00, [255, 250, 200]],
  ],
};

function buildLUT(stops) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = stops[0], b = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k][0] && t <= stops[k + 1][0]) {
        a = stops[k];
        b = stops[k + 1];
        break;
      }
    }
    const span = b[0] - a[0] || 1;
    const u = (t - a[0]) / span;
    lut[i * 3 + 0] = Math.round(a[1][0] + (b[1][0] - a[1][0]) * u);
    lut[i * 3 + 1] = Math.round(a[1][1] + (b[1][1] - a[1][1]) * u);
    lut[i * 3 + 2] = Math.round(a[1][2] + (b[1][2] - a[1][2]) * u);
  }
  return lut;
}

function resolveColormap(name) {
  if (Array.isArray(name)) return name;
  return COLORMAPS[name] || COLORMAPS.heatmap;
}

export class SpectrogramTerrain {
  constructor({
    freqBins = 192,
    timeSlices = 220,
    width = 24,
    depth = 14,
    maxHeight = 3.5,
    style = 'heatmap',     // 'heatmap' | 'shadow'
    colormap = null,       // colormap name ('heatmap'|'cool'|'warm') or stops array
    opacity = null,        // material opacity; defaults differ per style
    yOffset = 0,           // mesh Y position offset (use to layer shadows above heatmap)
  } = {}) {
    this.freqBins = freqBins;
    this.timeSlices = timeSlices;
    this.width = width;
    this.depth = depth;
    this.maxHeight = maxHeight;
    this.style = style;

    const cmName = colormap || (style === 'shadow' ? 'cool' : 'heatmap');
    this.lut = buildLUT(resolveColormap(cmName));
    this.history = new Float32Array(freqBins * timeSlices);
    this.headRow = 0;

    this.geometry = this._buildGeometry();
    if (style === 'shadow') {
      this.material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        wireframe: true,
        transparent: true,
        opacity: opacity ?? 0.55,
        depthWrite: false,
      });
    } else {
      this.material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: opacity ?? 0.95,
      });
    }
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = yOffset;
  }

  _buildGeometry() {
    const geom = new THREE.PlaneGeometry(
      this.width,
      this.depth,
      this.freqBins - 1,
      this.timeSlices - 1
    );
    // Both styles use vertex colors driven by their LUT.
    const colors = new Float32Array(geom.attributes.position.count * 3);
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geom;
  }

  rebuild(freqBins) {
    if (freqBins === this.freqBins) return;
    this.freqBins = freqBins;
    this.history = new Float32Array(this.freqBins * this.timeSlices);
    this.headRow = 0;
    this.geometry.dispose();
    this.geometry = this._buildGeometry();
    this.mesh.geometry = this.geometry;
  }

  /**
   * Map a linear-frequency analyser buffer (length N covering 0..sampleRate/2)
   * down to `freqBins` log-spaced buckets covering ~20Hz..maxHz.
   */
  _logBin(freqData, sampleRate) {
    const N = freqData.length;
    const nyquist = sampleRate / 2;
    const fMin = 20;
    const fMax = Math.min(20000, nyquist);
    const out = new Float32Array(this.freqBins);

    const logMin = Math.log(fMin);
    const logMax = Math.log(fMax);

    for (let i = 0; i < this.freqBins; i++) {
      const t0 = i / this.freqBins;
      const t1 = (i + 1) / this.freqBins;
      const f0 = Math.exp(logMin + (logMax - logMin) * t0);
      const f1 = Math.exp(logMin + (logMax - logMin) * t1);
      const b0 = Math.max(0, Math.floor((f0 / nyquist) * N));
      const b1 = Math.min(N, Math.max(b0 + 1, Math.ceil((f1 / nyquist) * N)));
      let sum = 0;
      for (let b = b0; b < b1; b++) sum += freqData[b];
      out[i] = (sum / (b1 - b0)) / 255;
    }
    return out;
  }

  pushFrame(freqData, sampleRate) {
    const row = this._logBin(freqData, sampleRate);
    for (let i = 0; i < row.length; i++) {
      row[i] = Math.pow(row[i], 0.7);
    }

    const rowOffset = this.headRow * this.freqBins;
    this.history.set(row, rowOffset);
    this.headRow = (this.headRow + 1) % this.timeSlices;

    this._updateMesh();
  }

  /** Push a row of zeros — keeps the time axis consistent when a track has no signal. */
  pushSilent() {
    const rowOffset = this.headRow * this.freqBins;
    this.history.fill(0, rowOffset, rowOffset + this.freqBins);
    this.headRow = (this.headRow + 1) % this.timeSlices;
    this._updateMesh();
  }

  _updateMesh() {
    const positions = this.geometry.attributes.position.array;
    const colors = this.geometry.attributes.color.array;
    const W = this.freqBins;
    const D = this.timeSlices;

    for (let r = 0; r < D; r++) {
      const histIdx = (this.headRow + r) % D;
      const histOff = histIdx * W;
      for (let c = 0; c < W; c++) {
        const v = this.history[histOff + c];
        const vIdx = (r * W + c) * 3;
        positions[vIdx + 2] = v * this.maxHeight;
        const lutIdx = Math.min(255, Math.max(0, Math.round(v * 255))) * 3;
        colors[vIdx + 0] = this.lut[lutIdx + 0] / 255;
        colors[vIdx + 1] = this.lut[lutIdx + 1] / 255;
        colors[vIdx + 2] = this.lut[lutIdx + 2] / 255;
      }
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }
}
