export class Track {
  constructor({ ctx, audioElement, mixBus, name, tint }) {
    this.ctx = ctx;
    this.audio = audioElement;
    this.name = name;
    this.tint = tint;
    this._objectURL = null;
    this._fileName = null;

    this.source = ctx.createMediaElementSource(this.audio);

    // 3-band EQ: low shelf @ 250 Hz, peaking @ 1 kHz, high shelf @ 4 kHz
    this.eq = {
      low:  ctx.createBiquadFilter(),
      mid:  ctx.createBiquadFilter(),
      high: ctx.createBiquadFilter(),
    };
    this.eq.low.type  = 'lowshelf';  this.eq.low.frequency.value  = 250;  this.eq.low.gain.value  = 0;
    this.eq.mid.type  = 'peaking';   this.eq.mid.frequency.value  = 1000; this.eq.mid.Q.value     = 1; this.eq.mid.gain.value = 0;
    this.eq.high.type = 'highshelf'; this.eq.high.frequency.value = 4000; this.eq.high.gain.value = 0;

    // Per-track analyser taps after EQ (so shadow reflects EQ shaping)
    // but before crossfader gain (so shadow stays visible when muted in the mix).
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.7;

    // Crossfader gain → mix bus → mixAnalyser → destination
    this.gain = ctx.createGain();
    this.gain.gain.value = 1;

    // Wire it up: source → low → mid → high → { analyser, gain → mixBus }
    this.source.connect(this.eq.low);
    this.eq.low.connect(this.eq.mid);
    this.eq.mid.connect(this.eq.high);
    this.eq.high.connect(this.analyser);
    this.eq.high.connect(this.gain);
    this.gain.connect(mixBus);

    this.freqBuffer = new Uint8Array(this.analyser.frequencyBinCount);
  }

  async loadFile(file) {
    if (this._objectURL) URL.revokeObjectURL(this._objectURL);
    this._objectURL = URL.createObjectURL(file);
    this._fileName = file.name;
    this.audio.src = this._objectURL;
    await new Promise((resolve, reject) => {
      const onLoaded = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('Failed to load audio')); };
      const cleanup = () => {
        this.audio.removeEventListener('loadedmetadata', onLoaded);
        this.audio.removeEventListener('error', onError);
      };
      this.audio.addEventListener('loadedmetadata', onLoaded);
      this.audio.addEventListener('error', onError);
      this.audio.load();
    });
  }

  unload() {
    this.audio.pause();
    if (this._objectURL) URL.revokeObjectURL(this._objectURL);
    this._objectURL = null;
    this._fileName = null;
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  async play() {
    if (!this.hasFile) return;
    await this.audio.play();
  }

  pause() { this.audio.pause(); }
  seek(t) { this.audio.currentTime = Math.max(0, Math.min(t, this.audio.duration || 0)); }

  get currentTime() { return this.audio.currentTime; }
  get duration() { return this.audio.duration || 0; }
  get paused() { return this.audio.paused; }
  get hasFile() { return !!this._fileName; }
  get fileName() { return this._fileName; }

  setFftSize(n) {
    this.analyser.fftSize = n;
    this.freqBuffer = new Uint8Array(this.analyser.frequencyBinCount);
  }

  setSmoothing(v) {
    this.analyser.smoothingTimeConstant = Math.max(0, Math.min(0.99, v));
  }

  getFrequencyData() {
    this.analyser.getByteFrequencyData(this.freqBuffer);
    return this.freqBuffer;
  }

  setEqGain(band, db) {
    const f = this.eq[band];
    if (f) f.gain.value = db;
  }

  getEqGain(band) {
    return this.eq[band]?.gain.value ?? 0;
  }
}

export class MixerEngine {
  constructor({ audioElA, audioElB }) {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Mix bus and mix analyser (post crossfader gains)
    this.mixBus = this.ctx.createGain();
    this.mixBus.gain.value = 1;
    this.mixAnalyser = this.ctx.createAnalyser();
    this.mixAnalyser.fftSize = 2048;
    this.mixAnalyser.smoothingTimeConstant = 0.7;
    this.mixBus.connect(this.mixAnalyser);
    this.mixAnalyser.connect(this.ctx.destination);
    this.mixBuffer = new Uint8Array(this.mixAnalyser.frequencyBinCount);

    this.tracks = [
      new Track({ ctx: this.ctx, audioElement: audioElA, mixBus: this.mixBus, name: 'A', tint: 0x6cf3ff }),
      new Track({ ctx: this.ctx, audioElement: audioElB, mixBus: this.mixBus, name: 'B', tint: 0xffb66c }),
    ];

    // Default crossfader at center → both tracks audible immediately
    this._crossfade = 0.5;
    this.setCrossfade(0.5);
  }

  get trackA() { return this.tracks[0]; }
  get trackB() { return this.tracks[1]; }

  /**
   * Equal-power crossfade. t ∈ [0, 1]:
   *   t=0 → A solo, t=1 → B solo, t=0.5 → both at ~0.707
   */
  setCrossfade(t) {
    t = Math.max(0, Math.min(1, t));
    this._crossfade = t;
    this.tracks[0].gain.gain.value = Math.cos(t * Math.PI / 2);
    this.tracks[1].gain.gain.value = Math.sin(t * Math.PI / 2);
  }

  get crossfade() { return this._crossfade; }

  setFftSize(n) {
    this.mixAnalyser.fftSize = n;
    this.mixBuffer = new Uint8Array(this.mixAnalyser.frequencyBinCount);
    for (const t of this.tracks) t.setFftSize(n);
  }

  setSmoothing(v) {
    this.mixAnalyser.smoothingTimeConstant = Math.max(0, Math.min(0.99, v));
    for (const t of this.tracks) t.setSmoothing(v);
  }

  async ensureRunning() {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  getMixFrequencyData() {
    this.mixAnalyser.getByteFrequencyData(this.mixBuffer);
    return this.mixBuffer;
  }

  get sampleRate() { return this.ctx.sampleRate; }

  get anyPlaying() {
    return this.tracks.some(t => !t.paused);
  }
}
