function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function bindUI({ mixer, onMixModeChange }) {
  const trackA = mixer.trackA;
  const trackB = mixer.trackB;

  const overlay   = document.getElementById('drop-overlay');
  const fileInput = document.getElementById('file-input');
  const fileInputB = document.getElementById('file-input-b');
  const transport = document.getElementById('transport');
  const playPause = document.getElementById('play-pause');
  const seek      = document.getElementById('seek');
  const timeLabel = document.getElementById('time-label');
  const loadNew   = document.getElementById('load-new');
  const settingsToggle = document.getElementById('settings-toggle');
  const settingsPanel  = document.getElementById('settings-panel');
  const fftSelect = document.getElementById('fft-size');
  const smoothing = document.getElementById('smoothing');
  const smoothingVal = document.getElementById('smoothing-val');
  const mixToggle = document.getElementById('mix-toggle');
  const mixPanel = document.getElementById('mix-panel');
  const crossfader = document.getElementById('crossfader');

  const state = {
    mixMode: false,
    pendingTarget: 'A', // which track the next file load should go to
  };

  const isAudioFile = (file) =>
    !!file && (file.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(file.name));

  const loadIntoTrack = async (track, file) => {
    if (!file || !isAudioFile(file)) {
      console.warn('Not an audio file:', file?.name, file?.type);
      return false;
    }
    try {
      await mixer.ensureRunning();
      await track.loadFile(file);
      await track.play();
      refreshTrackUI(track);
      return true;
    } catch (e) {
      console.error(`Could not load audio into Track ${track.name}:`, e);
      return false;
    }
  };

  const onFirstLoad = (track) => {
    overlay.classList.add('hidden');
    transport.hidden = false;
  };

  const acceptFile = async (file, target = state.pendingTarget) => {
    const track = target === 'B' ? trackB : trackA;
    const wasFirst = !trackA.hasFile && !trackB.hasFile;
    const ok = await loadIntoTrack(track, file);
    if (ok && wasFirst) onFirstLoad(track);
    return ok;
  };

  // ---- Drop / file picking (overlay = first load) ----
  overlay.addEventListener('click', () => { state.pendingTarget = 'A'; fileInput.click(); });
  fileInput.addEventListener('change', () => acceptFile(fileInput.files?.[0], 'A'));
  fileInputB.addEventListener('change', () => acceptFile(fileInputB.files?.[0], 'B'));

  ['dragenter', 'dragover'].forEach(ev =>
    overlay.addEventListener(ev, (e) => { e.preventDefault(); overlay.classList.add('dragover'); }));
  ['dragleave', 'dragend'].forEach(ev =>
    overlay.addEventListener(ev, () => overlay.classList.remove('dragover')));
  overlay.addEventListener('drop', (e) => {
    e.preventDefault();
    overlay.classList.remove('dragover');
    const f = e.dataTransfer?.files?.[0];
    if (f) acceptFile(f, 'A');
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) acceptFile(f, state.pendingTarget);
  });

  // ---- Master transport (bottom bar) ----
  // Operates on all loaded tracks together. Visible whenever any track is loaded,
  // including in mix mode (where it acts as the master alongside the per-track controls).
  const updatePlayIcon = (btn, paused) => {
    btn.innerHTML = paused ? '&#9658;' : '&#10074;&#10074;';
  };

  const loadedTracks = () => mixer.tracks.filter(t => t.hasFile);

  // Pick the loaded track with the longer duration as the canonical timeline source.
  const masterTrack = () => {
    const ts = loadedTracks();
    if (ts.length === 0) return null;
    return ts.reduce((a, b) => (b.duration || 0) > (a.duration || 0) ? b : a);
  };

  const masterDuration = () => masterTrack()?.duration || 0;
  const masterCurrentTime = () => masterTrack()?.currentTime || 0;
  const anyPlaying = () => mixer.tracks.some(t => !t.paused && t.hasFile);

  const refreshMasterIcon = () => updatePlayIcon(playPause, !anyPlaying());

  playPause.addEventListener('click', async () => {
    const ts = loadedTracks();
    if (ts.length === 0) return;
    await mixer.ensureRunning();
    if (anyPlaying()) {
      // Pause everything
      for (const t of ts) t.pause();
    } else {
      // Resume everything that's loaded
      for (const t of ts) await t.play();
    }
  });
  loadNew.addEventListener('click', () => { state.pendingTarget = 'A'; fileInput.click(); });

  let seekingMain = false;
  seek.addEventListener('input', () => {
    seekingMain = true;
    const d = masterDuration();
    const t = parseFloat(seek.value) * d;
    timeLabel.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
  });
  seek.addEventListener('change', () => {
    const d = masterDuration();
    const t = parseFloat(seek.value) * d;
    for (const tr of loadedTracks()) tr.seek(t); // each clamped per its own duration
    seekingMain = false;
  });

  // Refresh master display from whichever track is the canonical timeline.
  // Hook every track's events (since the canonical track can change after a load).
  for (const tr of mixer.tracks) {
    tr.audio.addEventListener('play',  refreshMasterIcon);
    tr.audio.addEventListener('pause', refreshMasterIcon);
    tr.audio.addEventListener('ended', refreshMasterIcon);
    tr.audio.addEventListener('timeupdate', () => {
      if (seekingMain) return;
      const m = masterTrack();
      if (!m) return;
      const d = m.duration || 0;
      seek.value = d > 0 ? (m.currentTime / d).toString() : '0';
      timeLabel.textContent = `${fmtTime(m.currentTime)} / ${fmtTime(d)}`;
    });
  }

  // ---- Settings panel ----
  settingsToggle.addEventListener('click', () => {
    settingsPanel.hidden = !settingsPanel.hidden;
  });

  fftSelect.addEventListener('change', () => {
    mixer.setFftSize(parseInt(fftSelect.value, 10));
  });

  const setSmoothLabel = (v) => { smoothingVal.textContent = v.toFixed(2); };
  setSmoothLabel(parseFloat(smoothing.value));
  smoothing.addEventListener('input', () => {
    const v = parseFloat(smoothing.value);
    mixer.setSmoothing(v);
    setSmoothLabel(v);
  });

  // ---- Per-track UI (mix panel) ----
  const trackUIs = {
    A: {
      track: trackA,
      nameEl: document.getElementById('track-a-name'),
      playBtn: document.getElementById('track-a-play'),
      seek: document.getElementById('track-a-seek'),
      time: document.getElementById('track-a-time'),
      load: document.getElementById('track-a-load'),
      input: fileInput,
    },
    B: {
      track: trackB,
      nameEl: document.getElementById('track-b-name'),
      playBtn: document.getElementById('track-b-play'),
      seek: document.getElementById('track-b-seek'),
      time: document.getElementById('track-b-time'),
      load: document.getElementById('track-b-load'),
      input: fileInputB,
    },
  };

  function refreshTrackUI(track) {
    const ui = trackUIs[track.name];
    if (!ui) return;
    if (track.hasFile) {
      ui.nameEl.textContent = track.fileName;
      ui.nameEl.classList.remove('empty');
    } else {
      ui.nameEl.textContent = 'no file';
      ui.nameEl.classList.add('empty');
    }
    updatePlayIcon(ui.playBtn, track.paused);
    const d = track.duration || 0;
    ui.seek.value = d > 0 ? (track.currentTime / d).toString() : '0';
    ui.time.textContent = `${fmtTime(track.currentTime)} / ${fmtTime(d)}`;
  }

  for (const key of ['A', 'B']) {
    const ui = trackUIs[key];
    ui.load.addEventListener('click', () => { state.pendingTarget = key; ui.input.click(); });
    ui.playBtn.addEventListener('click', async () => {
      if (!ui.track.hasFile) { state.pendingTarget = key; ui.input.click(); return; }
      if (ui.track.paused) await ui.track.play();
      else ui.track.pause();
    });
    let seeking = false;
    ui.seek.addEventListener('input', () => {
      seeking = true;
      const t = parseFloat(ui.seek.value) * (ui.track.duration || 0);
      ui.time.textContent = `${fmtTime(t)} / ${fmtTime(ui.track.duration)}`;
    });
    ui.seek.addEventListener('change', () => {
      ui.track.seek(parseFloat(ui.seek.value) * (ui.track.duration || 0));
      seeking = false;
    });
    ui.track.audio.addEventListener('play',  () => updatePlayIcon(ui.playBtn, false));
    ui.track.audio.addEventListener('pause', () => updatePlayIcon(ui.playBtn, true));
    ui.track.audio.addEventListener('ended', () => updatePlayIcon(ui.playBtn, true));
    ui.track.audio.addEventListener('timeupdate', () => {
      if (seeking) return;
      const d = ui.track.duration || 0;
      ui.seek.value = d > 0 ? (ui.track.currentTime / d).toString() : '0';
      ui.time.textContent = `${fmtTime(ui.track.currentTime)} / ${fmtTime(d)}`;
    });
  }

  // ---- Mix-mode toggle ----
  mixToggle.addEventListener('change', () => {
    state.mixMode = mixToggle.checked;
    mixPanel.hidden = !state.mixMode;

    if (!state.mixMode) {
      // When leaving mix mode, pause B so only A keeps playing.
      // Leave the crossfader where it is — B is silent because it's paused.
    }
    // Bottom transport stays visible in both modes (it's the master).
    transport.hidden = !(trackA.hasFile || trackB.hasFile);

    refreshTrackUI(trackA);
    refreshTrackUI(trackB);
    refreshMasterIcon();
    onMixModeChange?.(state.mixMode);
  });

  crossfader.addEventListener('input', () => {
    mixer.setCrossfade(parseFloat(crossfader.value));
  });

  // ---- Per-track EQ sliders ----
  document.querySelectorAll('.eq-slider').forEach((slider) => {
    const trackKey = slider.dataset.track;       // 'A' | 'B'
    const band = slider.dataset.band;            // 'low' | 'mid' | 'high'
    const track = trackKey === 'B' ? trackB : trackA;
    slider.addEventListener('input', () => {
      track.setEqGain(band, parseFloat(slider.value));
    });
  });

  // Initial paint
  refreshTrackUI(trackA);
  refreshTrackUI(trackB);
  refreshMasterIcon();
}
