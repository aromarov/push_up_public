// Чистая логика счёта: сигналы, калибровка, стейт-машина. Без DOM — переиспользуется в replay-скрипте.

export const LOG_POINTS = {
  nose: 0, l_eye: 2, r_eye: 5, l_ear: 7, r_ear: 8,
  l_sh: 11, r_sh: 12, l_hip: 23, r_hip: 24,
  l_knee: 25, r_knee: 26, l_ank: 27, r_ank: 28,
};

export const DEFAULTS = {
  downFrac: 0.35,   // ниже этой доли диапазона — «низ»
  upFrac: 0.65,     // выше — «верх»
  dwellMs: 80,      // сколько держать за порогом, чтобы сменить состояние
  minRepMs: 400,    // повтор короче не засчитывается
  maxGapMs: 1000,   // дольше без позы — сбрасываем незавершённый переход
  emaAlpha: 0.5,
  windowMs: 10000,  // окно автокалибровки
  minVis: 0.5,
};

// Минимальный диапазон движения, чтобы считать калибровку валидной.
export const MIN_RANGE = { a: 0.25, b: 0.15 };

// Оба сигнала ориентированы так, что «верх» = большее значение.
// a: высота середины плеч над низом кадра, в ширинах плеч.
// b: обратный масштаб плеч (≈ расстояние до камеры), в ширинах плеч на ширину кадра.
export function computeSignals(lm, W, H, minVis) {
  const l = lm[LOG_POINTS.l_sh], r = lm[LOG_POINTS.r_sh];
  if (!l || !r || l.visibility < minVis || r.visibility < minVis) return null;
  const sw = Math.hypot((l.x - r.x) * W, (l.y - r.y) * H);
  if (sw < 1) return null;
  const midY = (l.y + r.y) / 2;
  return { a: ((1 - midY) * H) / sw, b: W / sw };
}

export class Calibrator {
  constructor(minRange) {
    this.minRange = minRange;
    this.buf = [];
    this.auto = null;                       // { lo, hi }
    this.manual = { top: null, bottom: null };
  }

  push(t, v, windowMs) {
    this.buf.push([t, v]);
    while (this.buf.length && t - this.buf[0][0] > windowMs) this.buf.shift();
    if (this.buf.length < 10) return;
    const s = this.buf.map((p) => p[1]).sort((x, y) => x - y);
    const lo = s[Math.floor(s.length * 0.05)];
    const hi = s[Math.ceil(s.length * 0.95) - 1];
    // Узкий диапазон (стоим на месте) не затирает прошлую калибровку.
    if (hi - lo >= this.minRange) this.auto = { lo, hi };
  }

  // Возвращает значения сигнала в нижней и верхней точке или null.
  range(mode, invert) {
    if (mode === 'manual') {
      const { top, bottom } = this.manual;
      return top != null && bottom != null && top !== bottom ? { down: bottom, up: top } : null;
    }
    if (!this.auto) return null;
    const { lo, hi } = this.auto;
    return invert ? { down: hi, up: lo } : { down: lo, up: hi };
  }
}

// Прогресс 0 = низ, 1 = верх.
export function progress(v, rng) {
  return (v - rng.down) / (rng.up - rng.down);
}

export class RepCounter {
  constructor() { this.reset(); }

  reset() {
    this.state = 'up';
    this.count = 0;
    this.pendingSince = null;
    this.leftUpAt = null;
    this.lastT = null;
  }

  // true, если на этом кадре засчитан повтор.
  update(t, p, s) {
    if (this.lastT != null && t - this.lastT > s.maxGapMs) this.pendingSince = null;
    this.lastT = t;
    const wantFlip = this.state === 'up' ? p < s.downFrac : p > s.upFrac;
    if (!wantFlip) { this.pendingSince = null; return false; }
    if (this.pendingSince == null) this.pendingSince = t;
    if (t - this.pendingSince < s.dwellMs) return false;
    this.pendingSince = null;
    if (this.state === 'up') {
      this.state = 'down';
      this.leftUpAt = t;
      return false;
    }
    this.state = 'up';
    if (t - this.leftUpAt < s.minRepMs) return false;
    this.count++;
    return true;
  }
}
