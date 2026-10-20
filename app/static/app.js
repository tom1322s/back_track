const STEMS = ["vocals", "drums", "bass", "other"];

const uploadPane = document.getElementById("upload-pane");
const playerPane = document.getElementById("player-pane");
const fileInput = document.getElementById("file-input");
const uploadBtn = document.getElementById("upload-btn");
const uploadStatus = document.getElementById("upload-status");
const libraryEl = document.getElementById("library");
const trackName = document.getElementById("track-name");
const playBtn = document.getElementById("play-btn");
const stopBtn = document.getElementById("stop-btn");
const timeDisplay = document.getElementById("time-display");
const tracksEl = document.getElementById("tracks");
const chordNowEl = document.querySelector("#chord-now .chord-slots");
const chordNextEl = document.querySelector("#chord-next .chord-slots");
const keyValueEl = document.getElementById("key-value");
const origBpmEl = document.getElementById("orig-bpm");
const targetBpmEl = document.getElementById("target-bpm");
const speedVal = document.getElementById("speed-val");
const preservePitch = document.getElementById("preserve-pitch");
const metroToggle = document.getElementById("metro-toggle");
const metroBeats = document.getElementById("metro-beats");
const backBtn = document.getElementById("back-btn");
const semiUp = document.getElementById("semi-up");
const semiDown = document.getElementById("semi-down");
const semiVal = document.getElementById("semi-val");
const transposeStatus = document.getElementById("transpose-status");

const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const SEMI_LIMIT = 6;

const METRO_KEY = "__metro__";

let ctx = null;
let audios = {};         // stem -> HTMLAudioElement
let gains = {};          // stem -> GainNode
let buffers = {};        // stem -> AudioBuffer (for waveform)
let canvases = {};       // stem -> canvas
let playheads = {};      // stem -> div
let volumes = {};        // stem -> number (metro included as METRO_KEY)
let muted = {};          // stem -> bool (metro included)
let soloed = new Set();  // stem names, metro included

let metroGain = null;
let metroCanvas = null;
let metroPlayhead = null;

let rafId = null;
let originalBpm = null;
let beatOffset = 0;
let beatTimes = [];      // detected beat times in song time (seconds)
let chords = [];         // [{start, end, name}]
let keyName = null;
let metroOn = false;
let currentJobId = null;
let semitones = 0;
let _cachedBeats = null;
let _cachedBeatsDur = -1;

// ---------- Upload / library ----------

async function refreshLibrary() {
  const r = await fetch("/api/library");
  const data = await r.json();
  libraryEl.innerHTML = "";
  if (!data.items.length) {
    libraryEl.innerHTML = '<div style="color:var(--muted);">No separated tracks yet.</div>';
    return;
  }
  for (const item of data.items) {
    const el = document.createElement("div");
    el.className = "library-item";
    el.innerHTML = `<span>${item.name}</span><button class="secondary">Open</button>`;
    el.querySelector("button").onclick = () => openTrack(item.job_id, item.name);
    libraryEl.appendChild(el);
  }
}

uploadBtn.onclick = async () => {
  const f = fileInput.files[0];
  if (!f) { uploadStatus.textContent = "pick a file first"; return; }
  uploadBtn.disabled = true;
  uploadStatus.textContent = "uploading…";
  const fd = new FormData();
  fd.append("file", f);
  try {
    const r = await fetch("/api/separate", { method: "POST", body: fd });
    const data = await r.json();
    if (data.status === "done") {
      uploadStatus.textContent = "already separated — opening";
      openTrack(data.job_id, f.name);
    } else {
      uploadStatus.textContent = "separating… this takes a few minutes";
      await pollJob(data.job_id, f.name);
    }
  } catch (e) {
    uploadStatus.textContent = "error: " + e.message;
  } finally {
    uploadBtn.disabled = false;
  }
};

async function pollJob(jobId, name) {
  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await fetch(`/api/status/${jobId}`);
    const data = await r.json();
    if (data.status === "done") {
      uploadStatus.textContent = "done";
      refreshLibrary();
      openTrack(jobId, name);
      return;
    }
    if (data.status === "error") {
      uploadStatus.textContent = "error: " + (data.error || "unknown");
      return;
    }
    uploadStatus.textContent = `separating… (${data.status})`;
  }
}

// ---------- Player ----------

async function openTrack(jobId, name) {
  teardown();
  trackName.textContent = name;
  uploadPane.classList.add("hidden");
  playerPane.classList.remove("hidden");
  await setupTrack(jobId);
}

function teardown() {
  stopPlayback();
  for (const a of Object.values(audios)) a.src = "";
  audios = {}; gains = {}; buffers = {}; canvases = {}; playheads = {};
  volumes = {}; muted = {}; soloed = new Set();
  tracksEl.innerHTML = "";
  chordNowEl.innerHTML = ""; chordNextEl.innerHTML = "";
  keyValueEl.textContent = "–"; origBpmEl.textContent = "–";
  speedVal.textContent = "1.00x";
  originalBpm = null; beatOffset = 0; beatTimes = []; chords = []; keyName = null;
  metroOn = false; metroToggle.textContent = "Off"; metroToggle.classList.remove("toggle-on");
  metroCanvas = null; metroPlayhead = null; metroGain = null;
  nextBeatToSchedule = 0; scheduledClicks = [];
  currentJobId = null; semitones = 0; semiVal.textContent = "0";
  transposeStatus.textContent = "";
  _cachedBeats = null; _cachedBeatsDur = -1;
  if (ctx) { ctx.close(); ctx = null; }
}

function buildTrackRow(stemName, isMetro) {
  const row = document.createElement("div");
  row.className = "track" + (isMetro ? " metro-track" : "");
  row.innerHTML = `
    <div class="label">${stemName}</div>
    <div class="wave-wrap">
      <canvas></canvas>
      <div class="playhead"></div>
    </div>
    <div class="side">
      <button class="mute">M</button>
      <button class="solo">S</button>
      <input type="range" class="vol" min="0" max="1" step="0.01" value="${isMetro ? 0.6 : 0.9}" />
    </div>
  `;
  const key = isMetro ? METRO_KEY : stemName;
  volumes[key] = isMetro ? 0.6 : 0.9;
  muted[key] = false;
  const vol = row.querySelector(".vol");
  vol.oninput = () => { volumes[key] = parseFloat(vol.value); applyGains(); };
  row.querySelector(".mute").onclick = (e) => {
    muted[key] = !muted[key];
    e.currentTarget.classList.toggle("active", muted[key]);
    applyGains();
  };
  row.querySelector(".solo").onclick = (e) => {
    if (soloed.has(key)) soloed.delete(key); else soloed.add(key);
    e.currentTarget.classList.toggle("active", soloed.has(key));
    applyGains();
  };
  // Click anywhere on the row (except the sidebar controls) seeks the whole mix.
  row.onclick = (e) => {
    if (e.target.closest(".side")) return;
    const waveWrap = row.querySelector(".wave-wrap");
    const rect = waveWrap.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekToFrac(frac);
  };
  return row;
}

function seekToFrac(frac) {
  const lead = audios[STEMS[0]];
  if (!lead || !lead.duration) return;
  const t = frac * lead.duration;
  for (const stem of STEMS) audios[stem].currentTime = t;
  resetMetroScheduler();
  updatePlayheads();
  updateTimeDisplay();
  updateChordBars();
}

async function setupTrack(jobId) {
  currentJobId = jobId;
  semitones = 0;
  semiVal.textContent = "0";
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  metroGain = ctx.createGain();
  metroGain.gain.value = 0.6;
  metroGain.connect(ctx.destination);

  // Metronome row first.
  const metroRow = buildTrackRow("metro", true);
  tracksEl.appendChild(metroRow);
  metroCanvas = metroRow.querySelector("canvas");
  metroPlayhead = metroRow.querySelector(".playhead");

  // Stem rows.
  for (const stem of STEMS) {
    const row = buildTrackRow(stem, false);
    tracksEl.appendChild(row);
    canvases[stem] = row.querySelector("canvas");
    playheads[stem] = row.querySelector(".playhead");

    const audio = new Audio(`/api/stems/${jobId}/${stem}`);
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.preservesPitch = preservePitch.checked;
    const src = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    src.connect(gain).connect(ctx.destination);
    audios[stem] = audio; gains[stem] = gain;
  }

  audios[STEMS[0]].addEventListener("loadedmetadata", updateTimeDisplay, { once: true });

  const [meta] = await Promise.all([
    fetch(`/api/meta/${jobId}`).then(r => r.json()),
    ...STEMS.map(async stem => {
      const r = await fetch(`/api/stems/${jobId}/${stem}`);
      const ab = await r.arrayBuffer();
      buffers[stem] = await ctx.decodeAudioData(ab);
      drawWaveform(canvases[stem], buffers[stem]);
    }),
  ]);

  originalBpm = meta.bpm;
  beatOffset = meta.offset || 0;
  beatTimes = meta.beats || [];
  chords = meta.chords || [];
  keyName = meta.key || null;
  refreshKeyLabel();
  if (originalBpm) {
    origBpmEl.textContent = originalBpm;
    targetBpmEl.value = Math.round(originalBpm);
    targetBpmEl.disabled = false;
    setSpeedFromBpm(originalBpm);
  } else {
    origBpmEl.textContent = "–";
    targetBpmEl.value = "";
    targetBpmEl.placeholder = "n/a";
    targetBpmEl.disabled = true;
  }
  drawMetroGrid();
  updateChordBars();

  window.addEventListener("resize", onResize);
}

function onResize() {
  for (const stem of STEMS) if (buffers[stem]) drawWaveform(canvases[stem], buffers[stem]);
  drawMetroGrid();
}

function applyGains() {
  const anySolo = soloed.size > 0;
  for (const stem of STEMS) {
    let g = volumes[stem];
    if (muted[stem]) g = 0;
    else if (anySolo && !soloed.has(stem)) g = 0;
    gains[stem].gain.value = g;
  }
  let mg = volumes[METRO_KEY];
  if (muted[METRO_KEY]) mg = 0;
  else if (anySolo && !soloed.has(METRO_KEY)) mg = 0;
  if (metroGain) metroGain.gain.value = mg;
}

// ---------- Waveform drawing ----------

function sizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const c = canvas.getContext("2d");
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.scale(dpr, dpr);
  return { c, w: rect.width, h: rect.height };
}

function drawWaveform(canvas, buffer) {
  const { c, w, h } = sizeCanvas(canvas);
  c.clearRect(0, 0, w, h);
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / w));
  const mid = h / 2;
  c.fillStyle = "#0a2140";
  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    const start = x * step;
    const end = Math.min(data.length, start + step);
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = (1 - max) * mid;
    const y2 = (1 - min) * mid;
    c.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

function drawMetroGrid() {
  if (!metroCanvas) return;
  const { c, w, h } = sizeCanvas(metroCanvas);
  c.clearRect(0, 0, w, h);
  const dur = audios[STEMS[0]] && audios[STEMS[0]].duration;
  if (!dur) return;
  const beatsPerBar = Math.max(1, parseInt(metroBeats.value, 10) || 4);
  const times = allBeatTimes(dur);
  for (let n = 0; n < times.length; n++) {
    const x = (times[n] / dur) * w;
    const isDown = n % beatsPerBar === 0;
    c.fillStyle = isDown ? "#0a2140" : "rgba(10,33,64,0.55)";
    const barH = isDown ? h : h * 0.55;
    c.fillRect(x, h - barH, isDown ? 2 : 1, barH);
  }
}

// Beat times across the whole track — extrapolated backward to 0 and forward to dur.
function allBeatTimes(dur) {
  if (!dur) return [];
  if (_cachedBeats && _cachedBeatsDur === dur) return _cachedBeats;
  const out = [];
  if (beatTimes.length >= 2) {
    const gaps = [];
    for (let i = 1; i < beatTimes.length; i++) gaps.push(beatTimes[i] - beatTimes[i - 1]);
    gaps.sort((a, b) => a - b);
    const gap = gaps[Math.floor(gaps.length / 2)];
    // Backward.
    const pre = [];
    for (let t = beatTimes[0] - gap; t >= 0; t -= gap) pre.push(t);
    pre.reverse();
    out.push(...pre, ...beatTimes);
    // Forward.
    for (let t = beatTimes[beatTimes.length - 1] + gap; t <= dur; t += gap) out.push(t);
  } else if (originalBpm) {
    const gap = 60 / originalBpm;
    let t = beatOffset % gap;
    if (t < 0) t += gap;
    for (; t <= dur; t += gap) out.push(t);
  }
  _cachedBeats = out;
  _cachedBeatsDur = dur;
  return out;
}

// ---------- Transport ----------

playBtn.onclick = async () => {
  if (!ctx) return;
  if (ctx.state === "suspended") await ctx.resume();
  const lead = audios[STEMS[0]];
  if (!lead.paused) {
    for (const stem of STEMS) audios[stem].pause();
    playBtn.textContent = "Play";
    cancelAnimationFrame(rafId);
    cancelScheduledClicks();
  } else {
    const t = lead.currentTime;
    for (const stem of STEMS) audios[stem].currentTime = t;
    resetMetroScheduler();
    await Promise.all(STEMS.map(s => audios[s].play()));
    playBtn.textContent = "Pause";
    tick();
  }
};

stopBtn.onclick = () => stopPlayback();

function stopPlayback() {
  for (const a of Object.values(audios)) { a.pause(); a.currentTime = 0; }
  if (playBtn) playBtn.textContent = "Play";
  cancelAnimationFrame(rafId);
  cancelScheduledClicks();
  nextBeatToSchedule = 0;
  updateTimeDisplay();
  updatePlayheads();
  updateChordBars();
}

function tick() {
  const lead = audios[STEMS[0]];
  for (const stem of STEMS.slice(1)) {
    const d = audios[stem].currentTime - lead.currentTime;
    if (Math.abs(d) > 0.04) audios[stem].currentTime = lead.currentTime;
  }
  if (metroOn) metroScheduler();
  updateTimeDisplay();
  updatePlayheads();
  updateChordBars();
  rafId = requestAnimationFrame(tick);
}

// ---------- Metronome scheduler ----------
// Looks ahead SCHEDULE_AHEAD seconds and schedules each upcoming beat on the
// AudioContext clock, so clicks fire sample-accurately rather than reactively.

const SCHEDULE_AHEAD = 0.12;  // seconds of audio to pre-schedule
let nextBeatToSchedule = 0;
let scheduledClicks = [];     // { osc, when }

function metroScheduler() {
  const lead = audios[STEMS[0]];
  if (!lead || lead.paused || !ctx) return;
  const times = allBeatTimes(lead.duration);
  if (!times.length) return;
  const beatsPerBar = Math.max(1, parseInt(metroBeats.value, 10) || 4);
  const rate = lead.playbackRate || 1;
  const nowSong = lead.currentTime;
  const nowWall = ctx.currentTime;
  const horizonSong = nowSong + SCHEDULE_AHEAD * rate;
  // Skip beats already past.
  while (nextBeatToSchedule < times.length && times[nextBeatToSchedule] < nowSong - 0.02) {
    nextBeatToSchedule++;
  }
  while (nextBeatToSchedule < times.length && times[nextBeatToSchedule] <= horizonSong) {
    const beatTime = times[nextBeatToSchedule];
    const whenWall = nowWall + Math.max(0, (beatTime - nowSong) / rate);
    scheduleClickAt(whenWall, nextBeatToSchedule % beatsPerBar === 0);
    nextBeatToSchedule++;
  }
  // Reap finished entries.
  const cutoff = ctx.currentTime - 0.3;
  scheduledClicks = scheduledClicks.filter(c => c.when > cutoff);
}

function scheduleClickAt(when, accent) {
  if (!ctx || !metroGain) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = accent ? 1500 : 1000;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(1, when + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  osc.connect(g).connect(metroGain);
  osc.start(when);
  osc.stop(when + 0.06);
  scheduledClicks.push({ osc, when });
}

function cancelScheduledClicks() {
  for (const c of scheduledClicks) {
    try { c.osc.stop(0); } catch (_) {}
  }
  scheduledClicks = [];
}

function resetMetroScheduler() {
  cancelScheduledClicks();
  const lead = audios[STEMS[0]];
  if (!lead) { nextBeatToSchedule = 0; return; }
  const times = allBeatTimes(lead.duration || Infinity);
  const t = lead.currentTime;
  nextBeatToSchedule = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] < t - 0.02) nextBeatToSchedule = i + 1; else break;
  }
}

function updateTimeDisplay() {
  const lead = audios[STEMS[0]];
  if (!lead) return;
  timeDisplay.textContent = `${fmt(lead.currentTime || 0)} / ${fmt(lead.duration || 0)}`;
}

function updatePlayheads() {
  const lead = audios[STEMS[0]];
  if (!lead || !lead.duration) return;
  const frac = lead.currentTime / lead.duration;
  for (const stem of STEMS) {
    if (!playheads[stem]) continue;
    const wrap = playheads[stem].parentElement;
    playheads[stem].style.left = `${frac * wrap.clientWidth}px`;
  }
  if (metroPlayhead) {
    const wrap = metroPlayhead.parentElement;
    metroPlayhead.style.left = `${frac * wrap.clientWidth}px`;
  }
}

function fmt(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

// ---------- Chord bars ----------

function audibleTime() {
  const lead = audios[STEMS[0]];
  if (!lead) return 0;
  const lat = (ctx && (ctx.outputLatency || ctx.baseLatency)) || 0;
  const rate = lead.playbackRate || 1;
  return Math.max(0, lead.currentTime - lat * rate);
}

function currentBarRange() {
  const lead = audios[STEMS[0]];
  if (!lead || !lead.duration) return null;
  const beatsPerBar = Math.max(1, parseInt(metroBeats.value, 10) || 4);
  const times = allBeatTimes(lead.duration);
  if (times.length < 2) return null;
  // Find beat index we're currently on, using the audible time.
  const t = audibleTime();
  let idx = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= t) idx = i; else break;
  }
  const barIdx = Math.floor(idx / beatsPerBar);
  const barStartBeat = barIdx * beatsPerBar;
  const barEndBeat = barStartBeat + beatsPerBar;
  const start = times[barStartBeat];
  const end = times[Math.min(barEndBeat, times.length - 1)] +
              (barEndBeat >= times.length ? 0 : 0);
  // For the last bar, extend to track end.
  const safeEnd = barEndBeat >= times.length ? lead.duration : times[barEndBeat];
  return { start, end: safeEnd, barIdx };
}

function chordsInRange(start, end) {
  if (!chords.length || end <= start) return [];
  const out = [];
  for (const ch of chords) {
    const s = Math.max(ch.start, start);
    const e = Math.min(ch.end, end);
    if (e - s > 0.05) out.push({ name: ch.name, span: e - s, start: s });
  }
  // Fallback: if nothing matched, there's a hole.
  if (!out.length) return [];
  // Merge adjacent same-chord slots.
  const merged = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const last = merged[merged.length - 1];
    if (last.name === out[i].name) { last.span += out[i].span; }
    else merged.push(out[i]);
  }
  return merged;
}

function shiftChord(name, semi) {
  if (!name) return name;
  const m = name.match(/^([A-G]#?)(.*)$/);
  if (!m) return name;
  const idx = NOTE_NAMES.indexOf(m[1]);
  if (idx < 0) return name;
  return NOTE_NAMES[((idx + semi) % 12 + 12) % 12] + m[2];
}

function shiftKey(k, semi) {
  if (!k) return k;
  const parts = k.split(" ");
  const idx = NOTE_NAMES.indexOf(parts[0]);
  if (idx < 0) return k;
  return NOTE_NAMES[((idx + semi) % 12 + 12) % 12] + " " + parts.slice(1).join(" ");
}

function renderChordBar(el, slots, highlightTime) {
  el.innerHTML = "";
  if (!slots.length) {
    const empty = document.createElement("div");
    empty.className = "chord-slot empty";
    empty.textContent = "–";
    el.appendChild(empty);
    return;
  }
  for (const s of slots) {
    const slot = document.createElement("div");
    slot.className = "chord-slot";
    slot.style.flex = s.span.toFixed(3);
    slot.textContent = shiftChord(s.name, semitones);
    if (highlightTime !== null && highlightTime >= s.start - 0.01 &&
        highlightTime < s.start + s.span - 0.01) {
      slot.classList.add("active");
    }
    el.appendChild(slot);
  }
}

function updateChordBars() {
  const lead = audios[STEMS[0]];
  if (!lead) return;
  const bar = currentBarRange();
  if (!bar) { chordNowEl.innerHTML = ""; chordNextEl.innerHTML = ""; return; }
  const nowSlots = chordsInRange(bar.start, bar.end);
  renderChordBar(chordNowEl, nowSlots, audibleTime());

  const beatsPerBar = Math.max(1, parseInt(metroBeats.value, 10) || 4);
  const times = allBeatTimes(lead.duration);
  const nextStartBeat = (bar.barIdx + 1) * beatsPerBar;
  const nextEndBeat = nextStartBeat + beatsPerBar;
  if (nextStartBeat >= times.length) {
    renderChordBar(chordNextEl, [], null);
    return;
  }
  const ns = times[nextStartBeat];
  const ne = nextEndBeat >= times.length ? lead.duration : times[nextEndBeat];
  renderChordBar(chordNextEl, chordsInRange(ns, ne), null);
}

// ---------- Speed / BPM ----------

function setSpeedFromBpm(targetBpm) {
  if (!originalBpm) return;
  let rate = targetBpm / originalBpm;
  rate = Math.max(0.5, Math.min(1.5, rate));
  speedVal.textContent = rate.toFixed(2) + "x";
  for (const stem of STEMS) audios[stem].playbackRate = rate;
  // Already-scheduled clicks assume the old rate — redo them.
  resetMetroScheduler();
}

targetBpmEl.oninput = () => {
  const t = parseFloat(targetBpmEl.value);
  if (!t || t < 10) return;
  setSpeedFromBpm(t);
};

preservePitch.onchange = () => {
  for (const stem of STEMS) audios[stem].preservesPitch = preservePitch.checked;
};

metroBeats.oninput = () => { drawMetroGrid(); updateChordBars(); };

backBtn.onclick = () => {
  teardown();
  playerPane.classList.add("hidden");
  uploadPane.classList.remove("hidden");
  refreshLibrary();
};

// ---------- Metronome ----------

function refreshKeyLabel() {
  keyValueEl.textContent = keyName ? shiftKey(keyName, semitones) : "–";
}

async function requestTranspose(delta) {
  const next = Math.max(-SEMI_LIMIT, Math.min(SEMI_LIMIT, semitones + delta));
  if (next === semitones || !currentJobId) return;
  semiUp.disabled = true; semiDown.disabled = true;
  semitones = next;
  semiVal.textContent = (semitones > 0 ? "+" : "") + semitones;
  refreshKeyLabel();
  updateChordBars();
  try {
    const r = await fetch("/api/transpose", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ job_id: currentJobId, semitones }),
    });
    let data = await r.json();
    if (!data.ready) {
      transposeStatus.textContent = "pitch-shifting…";
      while (true) {
        await new Promise(res => setTimeout(res, 1500));
        data = await fetch(`/api/transpose/${currentJobId}/${semitones}`).then(r => r.json());
        if (data.ready) break;
        if (data.error) { transposeStatus.textContent = "error: " + data.error; return; }
      }
    }
    transposeStatus.textContent = "";
    await swapStemSources();
  } finally {
    semiUp.disabled = false; semiDown.disabled = false;
  }
}

async function swapStemSources() {
  const lead = audios[STEMS[0]];
  const wasPlaying = !lead.paused;
  const t = lead.currentTime;
  for (const stem of STEMS) {
    audios[stem].pause();
    const q = semitones ? `?semitones=${semitones}` : "";
    audios[stem].src = `/api/stems/${currentJobId}/${stem}${q}`;
    audios[stem].load();
  }
  await Promise.all(STEMS.map(s => new Promise(res => {
    audios[s].addEventListener("canplay", res, { once: true });
  })));
  for (const stem of STEMS) audios[stem].currentTime = t;
  if (wasPlaying) {
    await Promise.all(STEMS.map(s => audios[s].play()));
  }
}

semiUp.onclick = () => requestTranspose(+1);
semiDown.onclick = () => requestTranspose(-1);

metroToggle.onclick = () => {
  metroOn = !metroOn;
  metroToggle.textContent = metroOn ? "On" : "Off";
  metroToggle.classList.toggle("toggle-on", metroOn);
  if (metroOn) resetMetroScheduler();
  else cancelScheduledClicks();
};

refreshLibrary();
