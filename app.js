import { PoseLandmarker } from './vendor/mediapipe/vision_bundle.mjs';
import {
  LOG_POINTS, DEFAULTS, MIN_RANGE, computeSignals, Calibrator, RepCounter, progress,
} from './counter.js';

const APP_VERSION = '0.1.0';
const GRAPH_MS = 10000;
const LOG_MAX_FRAMES = 30 * 60 * 20;

const $ = (id) => document.getElementById(id);
const video = $('video'), overlay = $('overlay'), octx = overlay.getContext('2d');
const graph = $('graph'), gctx = graph.getContext('2d');

const settings = loadSettings();
let landmarker = null, delegateUsed = null, audioCtx = null, wakeLock = null;
let running = false, lastVideoTime = -1, t0 = 0;
let cal, counter, ema, history, log;
let fps = 0, fpsFrames = 0, fpsT = 0, lastSig = null, lastP = null;
let calMode = 'auto';

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('pushup_settings') || '{}'); } catch {}
  return { ...DEFAULTS, signal: 'a', invert: false, ...saved };
}
function saveSettings() {
  try { localStorage.setItem('pushup_settings', JSON.stringify(settings)); } catch {}
}

let msgUntil = 0;
function setStatus(text) { if (performance.now() >= msgUntil) $('status').textContent = text; }
function showMsg(text) { $('status').textContent = text; msgUntil = performance.now() + 3000; }

// ---------- старт ----------

$('start').onclick = async () => {
  $('start').disabled = true;
  initAudio();
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(location.protocol !== 'https:' ? 'нужен https://' : 'браузер не даёт доступ к камере — открой в Safari');
    }
    $('start-msg').textContent = 'Камера…';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
    });
    video.srcObject = stream;
    await video.play();
    $('start-msg').textContent = 'Загрузка модели…';
    landmarker = landmarker || await createLandmarker();
    requestWakeLock();
    newSet();
    running = true;
    $('start-screen').hidden = true;
    requestAnimationFrame(loop);
  } catch (e) {
    $('start-msg').textContent = 'Ошибка: ' + (e.message || e);
    $('start').disabled = false;
  }
};

async function createLandmarker() {
  const base = new URL('./', location.href).href;
  const fileset = {
    wasmLoaderPath: base + 'vendor/mediapipe/vision_wasm_internal.js',
    wasmBinaryPath: base + 'vendor/mediapipe/vision_wasm_internal.wasm',
  };
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: base + 'models/pose_landmarker_lite.task', delegate },
    runningMode: 'VIDEO', numPoses: 1,
  });
  try {
    const l = await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
    delegateUsed = 'GPU';
    return l;
  } catch {
    delegateUsed = 'CPU';
    return PoseLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

function initAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
    beep(0); // разблокировка по жесту
  } catch {}
}

function beep(gain = 0.3) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.frequency.value = 880;
  g.gain.setValueAtTime(gain, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
  o.connect(g).connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + 0.13);
}

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) requestWakeLock();
});

// ---------- подход ----------

function newSet() {
  cal = { a: new Calibrator(MIN_RANGE.a), b: new Calibrator(MIN_RANGE.b) };
  counter = new RepCounter();
  ema = { a: null, b: null };
  history = [];
  calMode = 'auto';
  t0 = performance.now();
  log = {
    v: 1, app: APP_VERSION, started: new Date().toISOString(), ua: navigator.userAgent,
    video: { w: video.videoWidth, h: video.videoHeight }, delegate: delegateUsed,
    settings: { ...settings }, keypoints: Object.keys(LOG_POINTS),
    frames: [], events: [],
  };
  renderCount();
  renderControls();
}

function logEvent(type, data = {}) {
  if (log) log.events.push({ t: Math.round(performance.now() - t0), type, ...data });
}

// ---------- кадр ----------

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const now = performance.now();
  const res = landmarker.detectForVideo(video, now);
  const lm = res.landmarks && res.landmarks[0];
  processFrame(now - t0, lm, video.videoWidth, video.videoHeight);
  drawSkeleton(lm);
  fpsFrames++;
  if (now - fpsT >= 1000) { fps = fpsFrames * 1000 / (now - fpsT); fpsFrames = 0; fpsT = now; }
  if (!$('debug').hidden) { drawGraph(now - t0); renderStats(); }
}

function processFrame(t, lm, W, H) {
  const sig = lm ? computeSignals(lm, W, H, settings.minVis) : null;
  lastSig = sig;
  const k = settings.signal;
  let p = null, rng = null, v = null, counted = false;

  if (sig) {
    for (const key of ['a', 'b']) {
      ema[key] = ema[key] == null ? sig[key] : ema[key] + settings.emaAlpha * (sig[key] - ema[key]);
      cal[key].push(t, ema[key], settings.windowMs);
    }
    v = ema[k];
    rng = cal[k].range(calMode, settings.invert);
    if (rng) {
      p = progress(v, rng);
      counted = counter.update(t, p, settings);
    }
  }
  lastP = p;
  history.push({ t, v, rng, st: counter.state });
  while (history.length && t - history[0].t > GRAPH_MS) history.shift();

  if (counted) {
    beep();
    renderCount(true);
    logEvent('rep', { n: counter.count });
  }
  setStatus(!lm ? 'Не вижу тебя' : !sig ? 'Не вижу плечи' : !rng
    ? (calMode === 'auto' ? 'Калибровка: сделай повтор' : 'Ручная калибровка: задай верх и низ') : '');

  if (log.frames.length < LOG_MAX_FRAMES) {
    log.frames.push({
      t: Math.round(t),
      a: sig ? r3(sig.a) : null,
      b: sig ? r3(sig.b) : null,
      p: p == null ? null : r3(p),
      rng: rng ? [r3(rng.down), r3(rng.up)] : null,
      st: counter.state === 'up' ? 'U' : 'D',
      n: counter.count,
      kp: lm ? Object.values(LOG_POINTS).map((i) => [r3(lm[i].x), r3(lm[i].y), r2(lm[i].visibility)]) : null,
    });
  }
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const r2 = (x) => Math.round(x * 100) / 100;

// ---------- отрисовка ----------

function drawSkeleton(lm) {
  const W = video.videoWidth, H = video.videoHeight;
  if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
  octx.clearRect(0, 0, W, H);
  if (!lm) return;
  octx.lineWidth = Math.max(2, W / 200);
  octx.strokeStyle = '#3fb950';
  for (const { start, end } of PoseLandmarker.POSE_CONNECTIONS) {
    const a = lm[start], b = lm[end];
    if (a.visibility < 0.3 || b.visibility < 0.3) continue;
    octx.beginPath();
    octx.moveTo(a.x * W, a.y * H);
    octx.lineTo(b.x * W, b.y * H);
    octx.stroke();
  }
  for (const i of Object.values(LOG_POINTS)) {
    const pt = lm[i];
    octx.fillStyle = pt.visibility >= settings.minVis ? '#fff' : '#f85149';
    octx.beginPath();
    octx.arc(pt.x * W, pt.y * H, octx.lineWidth * 1.5, 0, Math.PI * 2);
    octx.fill();
  }
}

function drawGraph(tNow) {
  const dpr = window.devicePixelRatio || 1;
  const W = graph.clientWidth * dpr, H = graph.clientHeight * dpr;
  if (graph.width !== W || graph.height !== H) { graph.width = W; graph.height = H; }
  gctx.clearRect(0, 0, W, H);
  const pts = history.filter((h) => h.v != null);
  if (pts.length < 2) return;
  const last = history[history.length - 1].rng;
  const thLines = last ? [
    last.down + (last.up - last.down) * settings.downFrac,
    last.down + (last.up - last.down) * settings.upFrac,
  ] : [];
  let lo = Math.min(...pts.map((h) => h.v), ...thLines);
  let hi = Math.max(...pts.map((h) => h.v), ...thLines);
  const pad = (hi - lo) * 0.1 || 0.1; lo -= pad; hi += pad;
  const x = (t) => W - ((tNow - t) / GRAPH_MS) * W;
  const y = (v) => H - ((v - lo) / (hi - lo)) * H;

  gctx.fillStyle = 'rgba(31,111,235,0.18)';
  for (const h of history) if (h.st === 'down') gctx.fillRect(x(h.t), 0, Math.max(1, W / 300), H);

  gctx.setLineDash([6 * dpr, 4 * dpr]);
  gctx.lineWidth = dpr;
  thLines.forEach((v, i) => {
    gctx.strokeStyle = i === 0 ? '#f0883e' : '#3fb950';
    gctx.beginPath(); gctx.moveTo(0, y(v)); gctx.lineTo(W, y(v)); gctx.stroke();
  });
  gctx.setLineDash([]);
  gctx.strokeStyle = '#fff';
  gctx.lineWidth = 2 * dpr;
  gctx.beginPath();
  let started = false;
  for (const h of history) {
    if (h.v == null) { started = false; continue; }
    if (!started) { gctx.moveTo(x(h.t), y(h.v)); started = true; } else gctx.lineTo(x(h.t), y(h.v));
  }
  gctx.stroke();
}

function renderStats() {
  const k = settings.signal;
  const rng = cal[k].range(calMode, settings.invert);
  $('debug-stats').textContent = [
    `v${APP_VERSION}  ${delegateUsed}  fps ${fps.toFixed(1)}  ${video.videoWidth}x${video.videoHeight}`,
    `a ${fmt(lastSig?.a)}  b ${fmt(lastSig?.b)}  p ${fmt(lastP)}`,
    `сигнал ${k}  ${counter.state.toUpperCase()}  калибр ${calMode}  ` +
      (rng ? `низ ${fmt(rng.down)} верх ${fmt(rng.up)}` : 'нет'),
    `кадров в логе ${log.frames.length}`,
  ].join('\n');
}
const fmt = (x) => (x == null ? '—' : x.toFixed(3));

function renderCount(flash = false) {
  const el = $('count');
  el.textContent = counter.count;
  if (flash) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 250); }
}

// ---------- контролы ----------

const SLIDERS = [
  ['downFrac', 'порог низа', 0.05, 0.6, 0.01],
  ['upFrac', 'порог верха', 0.4, 0.95, 0.01],
  ['dwellMs', 'dwell, мс', 0, 300, 10],
  ['minRepMs', 'мин. повтор, мс', 100, 1500, 50],
  ['emaAlpha', 'сглаживание α', 0.1, 1, 0.05],
];

function buildSliders() {
  const box = $('sliders');
  for (const [key, label, min, max, step] of SLIDERS) {
    const row = document.createElement('label');
    row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}"><span></span>`;
    const input = row.querySelector('input'), out = row.lastElementChild;
    input.value = settings[key];
    out.textContent = settings[key];
    input.oninput = () => {
      settings[key] = Number(input.value);
      out.textContent = input.value;
      saveSettings();
    };
    input.onchange = () => logEvent('settings', { [key]: settings[key] });
    box.appendChild(row);
  }
}

function renderControls() {
  document.querySelectorAll('#signal-switch button').forEach((b) =>
    b.classList.toggle('on', b.dataset.signal === settings.signal));
  $('invert').checked = settings.invert;
  $('cal-auto').classList.toggle('on', calMode === 'auto');
  $('cal-top').classList.toggle('on', calMode === 'manual' && cal?.[settings.signal].manual.top != null);
  $('cal-bottom').classList.toggle('on', calMode === 'manual' && cal?.[settings.signal].manual.bottom != null);
}

document.querySelectorAll('#signal-switch button').forEach((b) => {
  b.onclick = () => {
    settings.signal = b.dataset.signal;
    saveSettings();
    if (counter) { counter.state = 'up'; counter.pendingSince = null; }
    logEvent('settings', { signal: settings.signal });
    renderControls();
  };
});

$('invert').onchange = () => {
  settings.invert = $('invert').checked;
  saveSettings();
  logEvent('settings', { invert: settings.invert });
};

$('cal-auto').onclick = () => { calMode = 'auto'; logEvent('cal', { mode: 'auto' }); renderControls(); };
$('cal-top').onclick = () => captureManual('top');
$('cal-bottom').onclick = () => captureManual('bottom');

// Отсчёт 3 с, потом медиана сигнала за 0.5 с — для обоих сигналов сразу.
function captureManual(which) {
  if (!running) return;
  const btn = which === 'top' ? $('cal-top') : $('cal-bottom');
  const label = btn.textContent;
  let left = 3;
  btn.textContent = `${left}…`;
  const timer = setInterval(() => {
    left--;
    if (left > 0) { btn.textContent = `${left}…`; return; }
    clearInterval(timer);
    const since = performance.now() - t0 - 500;
    for (const key of ['a', 'b']) {
      const vals = cal[key].buf.filter(([t]) => t >= since).map(([, v]) => v).sort((x, y) => x - y);
      if (vals.length) cal[key].manual[which] = vals[Math.floor(vals.length / 2)];
    }
    calMode = 'manual';
    beep(0.2);
    btn.textContent = label;
    logEvent('cal', { mode: 'manual', which, a: cal.a.manual[which], b: cal.b.manual[which] });
    renderControls();
  }, 1000);
}

$('new-set').onclick = () => { if (running) newSet(); };

$('toggle-debug').onclick = () => {
  $('debug').hidden = !$('debug').hidden;
  $('toggle-debug').classList.toggle('on', !$('debug').hidden);
};

function logJson() {
  return JSON.stringify({ ...log, finished: new Date().toISOString(), count: counter.count, settingsEnd: { ...settings } });
}

$('copy-log').onclick = async () => {
  if (!log) return;
  const text = logJson();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  showMsg(`Лог скопирован: ${log.frames.length} кадров, ${Math.round(text.length / 1024)} КБ`);
};

$('share-log').onclick = async () => {
  if (!log) return;
  const name = `pushup_log_${log.started.replace(/[:.]/g, '-')}.json`;
  const file = new File([logJson()], name, { type: 'application/json' });
  try {
    await navigator.share({ files: [file] });
  } catch (e) {
    if (e.name !== 'AbortError') showMsg('Поделиться не вышло: ' + e.message);
  }
};

buildSliders();
renderControls();
