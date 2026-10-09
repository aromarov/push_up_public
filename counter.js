// Чистая логика счёта: сигнал, фильтр мусорных кадров, стейт-машина. Без DOM — переиспользуется в replay-скрипте.

export const LOG_POINTS = {
  nose: 0, l_eye: 2, r_eye: 5, l_ear: 7, r_ear: 8,
  l_sh: 11, r_sh: 12, l_hip: 23, r_hip: 24,
  l_knee: 25, r_knee: 26, l_ank: 27, r_ank: 28,
};

// Пороги в ширинах плеч. По логам 2026-10-09: чистый повтор 1.0–1.2, на коленях 0.8–1.0,
// половинка 0.35–0.5, тряска головой ≤ 0.27, ложиться в позицию 1.5–2.0.
export const DEFAULTS = {
  downDepth: 0.6,   // провал глубже — «низ»
  upDepth: 0.25,    // вернулся выше — повтор засчитан
  halfDepth: 0.3,   // провал 0.3…downDepth без «низа» — половинка
  maxDepth: 1.6,    // глубже — не отжимание (лёг, встал, ушёл из кадра)
  dwellMs: 80,      // сколько держать за порогом, чтобы сменить состояние
  minRepMs: 300,    // повтор короче не засчитывается
  maxRepMs: 4000,   // «внизу» дольше — не повтор (встал, пошёл к телефону); у реальных 0.5–1.8 с
  maxBadMs: 700,    // мусор дольше этого внутри повтора — повтор не засчитывается
  emaAlpha: 0.5,
  topWindowMs: 10000, // окно, по которому ищем «верх» (p80)
  swWindowMs: 5000,   // окно медианы ширины плеч
  minVis: 0.5,
};

const median = (arr) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Вход — точки MediaPipe (координаты 0..1 исходного, не зеркального кадра).
// Сигнал: высота середины плеч над низом кадра, делённая на МЕДИАНУ ширины плеч за 5 с.
// Покадровая ширина в нижней точке схлопывается (лицо у камеры), поэтому на неё делить нельзя.
export class DepthCounter {
  constructor(s = DEFAULTS) {
    this.s = s;
    this.swBuf = []; this.hBuf = [];
    this.ema = null; this.state = 'up'; this.count = 0;
    this.pendingSince = null; this.downAt = null; this.maxD = 0;
    this.badSince = null; this.badMs = 0;
    this.last = null; // последние вычисленные значения — для UI и лога
  }

  // Возвращает 'rep', 'half' или null.
  update(t, lm, W, H) {
    const s = this.s;
    const l = lm?.[LOG_POINTS.l_sh], r = lm?.[LOG_POINTS.r_sh];
    if (!l || !r || l.visibility < s.minVis || r.visibility < s.minVis) return this.bad(t, 'noshoulders');
    const sw = Math.hypot((l.x - r.x) * W, (l.y - r.y) * H);
    const ready = this.swBuf.length > 30;
    const m = ready ? median(this.swBuf.map((x) => x[1])) : sw;
    // Левое плечо в исходном кадре фронталки правее правого; наоборот — модель перепутала стороны.
    if (l.x < r.x || sw < 1 || (ready && (sw < 0.7 * m || sw > 1.4 * m))) return this.bad(t, 'glitch', sw / W);
    this.badSince = null;

    this.swBuf.push([t, sw]);
    while (t - this.swBuf[0][0] > s.swWindowMs) this.swBuf.shift();
    const msw = median(this.swBuf.map((x) => x[1]));
    const h = ((1 - (l.y + r.y) / 2) * H) / msw;
    this.ema = this.ema == null ? h : this.ema + s.emaAlpha * (h - this.ema);
    this.hBuf.push([t, this.ema]);
    while (t - this.hBuf[0][0] > s.topWindowMs) this.hBuf.shift();
    if (this.hBuf.length < 30) { this.last = { t, sw: sw / W, d: null, ok: true }; return null; }

    const sorted = this.hBuf.map((x) => x[1]).sort((x, y) => x - y);
    const d = sorted[Math.floor(sorted.length * 0.8)] - this.ema;
    this.last = { t, sw: sw / W, d, ok: true };
    this.maxD = Math.max(this.maxD, d);

    const want = this.state === 'up' ? d > s.downDepth : d < s.upDepth;
    if (!want) {
      this.pendingSince = null;
      if (this.state === 'up' && d < s.upDepth) {
        const half = this.maxD >= s.halfDepth && this.maxD <= s.downDepth;
        this.maxD = 0;
        if (half) return 'half';
      }
      return null;
    }
    this.pendingSince ??= t;
    if (t - this.pendingSince < s.dwellMs) return null;
    this.pendingSince = null;
    if (this.state === 'up') {
      this.state = 'down'; this.downAt = t; this.badMs = 0;
      return null;
    }
    this.state = 'up';
    const depth = this.maxD; this.maxD = 0;
    const dur = t - this.downAt;
    if (dur < s.minRepMs || dur > s.maxRepMs || depth > s.maxDepth || this.badMs > s.maxBadMs) return null;
    this.count++;
    return 'rep';
  }

  bad(t, why, sw = null) {
    this.badSince ??= t;
    if (this.state === 'down') this.badMs = Math.max(this.badMs, t - this.badSince);
    this.pendingSince = null;
    this.last = { t, sw, d: null, ok: false, why };
    return null;
  }
}

// Подсказка, как поставить телефон. Цель — гипотеза: в верхней точке плечи 25–38% ширины кадра,
// тогда в нижней лицо не упирается в камеру. По логам 2026-10-09 вверху было 38–50% — близко.
export const FRAME_HINT = { minSw: 0.25, maxSw: 0.38 };
export function frameHint(swFrac) {
  if (swFrac == null) return null;
  if (swFrac > FRAME_HINT.maxSw) return 'far';   // слишком близко — отодвинь
  if (swFrac < FRAME_HINT.minSw) return 'near';  // слишком далеко — придвинь
  return 'ok';
}
