import { PoseLandmarker } from './vendor/mediapipe/vision_bundle.mjs';
import { LOG_POINTS, DEFAULTS, FRAME_HINT, DepthCounter, frameHint } from './counter.js';

const APP_VERSION = '0.3.1';
const COUNTDOWN_MS = 8000;
const GRAPH_MS = 10000;
const LOG_MAX_FRAMES = 30 * 60 * 20;

const $ = (id) => document.getElementById(id);
const video = $('video'), overlay = $('overlay'), octx = overlay.getContext('2d');
const graph = $('graph'), gctx = graph.getContext('2d');

const settings = loadSettings();
let landmarker = null, delegateUsed = null, audioCtx = null, wakeLock = null;
let running = false, lastVideoTime = -1, t0 = 0;
let counter, history, log, hint = null;
let goAt = 0, counting = false, modelMs = null;
let fps = 0, fpsFrames = 0, fpsT = 0;

// v2: в старом ключе залип minRepMs 400 из v0.1 и резал быстрые повторы. Берём только известные ключи.
const SETTINGS_KEY = 'pushup_settings_v2';
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch {}
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (typeof saved[k] === 'number') s[k] = saved[k];
  return s;
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

let msgUntil = 0;
function setStatus(text) { if (performance.now() >= msgUntil) $('status').textContent = text; }
function showMsg(text) { $('status').textContent = text; msgUntil = performance.now() + 3000; }

// ---------- старт ----------

// Модель грузим сразу при открытии страницы: пока жмёшь «Старт», даёшь камеру и встаёшь — она готовится.
const pageT0 = performance.now();
const landmarkerPromise = createLandmarker().then((l) => {
  landmarker = l;
  modelMs = Math.round(performance.now() - pageT0);
  return l;
});
landmarkerPromise.catch(() => {});

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
    requestWakeLock();
    newSet();
    running = true;
    $('start-screen').hidden = true;
    requestAnimationFrame(loop);
    await landmarkerPromise;
  } catch (e) {
    running = false;
    $('start-screen').hidden = false;
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

// Каждый подход начинается с отсчёта: встать в упор и поставить телефон по рамке.
// Счётчик в это время уже крутится (прогревает медиану и «верх»), но повторы не засчитывает.
function newSet() {
  counter = new DepthCounter(settings);
  history = [];
  counting = false;
  goAt = performance.now() + COUNTDOWN_MS;
  t0 = performance.now();
  log = {
    v: 1, app: APP_VERSION, started: new Date().toISOString(), ua: navigator.userAgent,
    video: { w: video.videoWidth, h: video.videoHeight }, delegate: delegateUsed,
    settings: { ...settings }, keypoints: Object.keys(LOG_POINTS),
    frames: [], events: [],
  };
  renderCount();
}

function tickCountdown(now) {
  if (counting) return;
  const left = Math.ceil((goAt - now) / 1000);
  if (left > 0) {
    $('count').textContent = left;
    if (!landmarker) setStatus('Приготовься, модель грузится');
    return;
  }
  if (!landmarker) { $('count').textContent = '…'; setStatus('Модель ещё грузится…'); return; }
  counting = true;
  counter.arm();
  beep(0.4);
  logEvent('go', { modelMs });
  renderCount(true);
}

function logEvent(type, data = {}) {
  if (log) log.events.push({ t: Math.round(performance.now() - t0), type, ...data });
}

// ---------- кадр ----------

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  tickCountdown(performance.now());
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
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
  const r = counter.update(t, lm, W, H);
  const ev = counting ? r : null;
  const last = counter.last;
  const d = last?.d ?? null;
  // Подсказку по расстоянию даём только в верхней точке: внизу плечи всегда шире.
  if (last?.ok && (d == null || d < settings.upDepth)) hint = frameHint(last.sw);
  // Рамка по краю экрана: оранжевая — телефон не там, зелёная — ок (только до первого повтора, потом не мешает).
  $('frame').className = hint && hint !== 'ok' ? 'bad' : hint === 'ok' && counter.count === 0 ? 'ok' : '';
  history.push({ t, d, st: counter.state });
  while (history.length && t - history[0].t > GRAPH_MS) history.shift();

  if (ev === 'rep') {
    beep();
    renderCount(true);
    logEvent('rep', { n: counter.count });
  } else if (ev === 'half') {
    showMsg('Трясучка на полшишки, бля');
    logEvent('half');
  }
  setStatus(!lm ? 'Не вижу тебя' : last?.why === 'noshoulders' ? 'Не вижу плечи'
    : hint === 'far' ? '↕ Отодвинь телефон дальше от лица' : hint === 'near' ? '↕ Придвинь телефон ближе'
    : !counting ? 'Приготовься, встань в упор' : counter.count === 0 ? 'Телефон стоит ок, погнали' : '');

  if (log.frames.length < LOG_MAX_FRAMES) {
    log.frames.push({
      t: Math.round(t),
      d: d == null ? null : r3(d),
      ok: last?.ok ? 1 : 0,
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
  const pts = history.filter((h) => h.d != null);
  if (pts.length < 2) return;
  const thLines = [settings.halfDepth, settings.downDepth, settings.upDepth];
  const lo = -0.2, hi = Math.max(1.4, ...pts.map((h) => h.d));
  const x = (t) => W - ((tNow - t) / GRAPH_MS) * W;
  const y = (v) => ((v - lo) / (hi - lo)) * H; // глубина растёт вниз

  gctx.fillStyle = 'rgba(31,111,235,0.18)';
  for (const h of history) if (h.st === 'down') gctx.fillRect(x(h.t), 0, Math.max(1, W / 300), H);

  gctx.setLineDash([6 * dpr, 4 * dpr]);
  gctx.lineWidth = dpr;
  thLines.forEach((v, i) => {
    gctx.strokeStyle = ['#d29922', '#f0883e', '#3fb950'][i];
    gctx.beginPath(); gctx.moveTo(0, y(v)); gctx.lineTo(W, y(v)); gctx.stroke();
  });
  gctx.setLineDash([]);
  gctx.strokeStyle = '#fff';
  gctx.lineWidth = 2 * dpr;
  gctx.beginPath();
  let started = false;
  for (const h of history) {
    if (h.d == null) { started = false; continue; }
    if (!started) { gctx.moveTo(x(h.t), y(h.d)); started = true; } else gctx.lineTo(x(h.t), y(h.d));
  }
  gctx.stroke();
}

function renderStats() {
  const last = counter.last;
  $('debug-stats').textContent = [
    `v${APP_VERSION}  ${delegateUsed}  fps ${fps.toFixed(1)}  ${video.videoWidth}x${video.videoHeight}`,
    `глубина ${fmt(last?.d)}  ${counter.state.toUpperCase()}  ${last?.ok ? '' : 'мусор: ' + (last?.why || '')}`,
    `плечи ${last?.sw == null ? '—' : Math.round(last.sw * 100) + '%'} кадра (цель ${FRAME_HINT.minSw * 100}–${FRAME_HINT.maxSw * 100}%)`,
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
  ['downDepth', 'низ, плеч', 0.3, 1.2, 0.05],
  ['upDepth', 'верх, плеч', 0.05, 0.5, 0.05],
  ['halfDepth', 'половинка, плеч', 0.1, 0.6, 0.05],
  ['dwellMs', 'dwell, мс', 0, 300, 10],
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
