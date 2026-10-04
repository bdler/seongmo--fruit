// 캔버스 렌더러. 규칙/물리는 모르고 main.js 가 넘겨주는 frame 만 그린다.
// 모듈 로드 시점에는 DOM 에 접근하지 않는다 (Node 에서 import 가능).
import { WORLD, FRUITS, LAST_LEVEL, MAX_DROP_LEVEL } from './config.js';

const TAU = Math.PI * 2;
const MAX_DPR = 3;
const POP_MS = 180;     // 합쳐져 태어난 과일이 튀는 시간 (렌더 전용, 물리 반지름은 이미 확정)
const POP_PEAK = 0.5;   // 0.8 -> 1.12 구간이 차지하는 비율
const EMOJI_K = 1.5;    // 이모지 글자 크기 / 반지름
const SPRITE_K = 1.8;   // 스프라이트 한 변 / 반지름
const BLINK_RAD_PER_MS = (TAU * 3) / 1000; // 경고 깜빡임 3Hz. 주파수를 고정해 위상이 튀지 않게 한다
const MAX_PARTICLES = 160;
const MAX_RINGS = 24;
const MAX_TEXTS = 10;
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
const UI_FONT = '"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",system-ui,sans-serif';
const GOLD = ['#ffd54f', '#ffeb3b', '#fff59d', '#ffca28', '#ffb300'];
const DASH = [10, 8];
const NO_DASH = [];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// 숫자가 아니거나 범위 밖이면 -1 (null/문자열이 0 으로 둔갑하지 않게 typeof 로 거른다)
function levelIndex(v) {
  if (typeof v !== 'number') return -1;
  const i = Math.floor(v);
  return i >= 0 && i <= LAST_LEVEL ? i : -1;
}

function parseColor(c) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c).trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// amt > 0: 흰색 쪽으로, amt < 0: 검정 쪽으로 섞는다. 해석 못 하는 색은 그대로 돌려준다.
export function shade(color, amt) {
  const rgb = parseColor(color);
  if (!rgb) return String(color);
  const t = amt < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(amt));
  return `rgb(${Math.round(rgb[0] + (t - rgb[0]) * p)},${Math.round(rgb[1] + (t - rgb[1]) * p)},${Math.round(rgb[2] + (t - rgb[2]) * p)})`;
}

function withAlpha(color, a) {
  const rgb = parseColor(color) || [128, 128, 128];
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

// age(ms) -> 스케일. 0.8 -> 1.12 -> 1.0. Infinity/NaN/범위 밖이면 1.
export function popScale(age) {
  if (!(age < POP_MS)) return 1;
  const t = age > 0 ? age / POP_MS : 0;
  if (t < POP_PEAK) {
    const k = t / POP_PEAK;
    return 0.8 + 0.32 * k * (2 - k);
  }
  const k = (t - POP_PEAK) / (1 - POP_PEAK);
  return 1.12 - 0.12 * k * k * (3 - 2 * k);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function currentDpr() {
  const d = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  return Math.min(d > 0 ? d : 1, MAX_DPR);
}

// 이모지를 (cx, cy) 에 시각적으로 가운데 오도록 그린다. 글자 박스가 아니라 실제 잉크 범위 기준.
function drawEmoji(g, text, cx, cy, size) {
  g.font = `${Math.max(1, Math.round(size))}px ${EMOJI_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  let y = null;
  try {
    const m = g.measureText(text);
    const asc = m.actualBoundingBoxAscent;
    const desc = m.actualBoundingBoxDescent;
    if (Number.isFinite(asc) && Number.isFinite(desc) && asc + desc > 0) {
      const yy = cy + (asc - desc) / 2;
      if (Math.abs(yy - cy) < size * 0.6) y = yy;
    }
  } catch (e) { /* 측정 실패 시 middle 기준으로 */ }
  if (y === null) {
    g.textBaseline = 'middle';
    y = cy;
  }
  g.fillText(text, cx, y);
}

// 과일 한 레벨의 비트맵 두 장. ppw = 월드 1단위당 비트맵 픽셀 수.
//  base: 방사형 그라데이션 원 + 이모지/스프라이트 (몸체 각도대로 회전)
//  over: 하이라이트/음영/외곽선 (회전하지 않아 빛이 항상 왼쪽 위에서 온다)
function buildSprite(level, ppw, img) {
  const f = FRUITS[level];
  const R = f.radius * ppw;
  const c = Math.ceil(R) + 2; // 중심이 정수 픽셀에 오도록
  const D = c * 2;
  const base = makeCanvas(D, D);
  const over = makeCanvas(D, D);
  const b = base.getContext('2d');
  const o = over.getContext('2d');
  if (!b || !o) return null;

  const fill = b.createRadialGradient(c, c, R * 0.05, c, c, R);
  fill.addColorStop(0, shade(f.color, 0.4));
  fill.addColorStop(0.6, f.color);
  fill.addColorStop(1, shade(f.color, -0.14));
  b.fillStyle = fill;
  b.beginPath();
  b.arc(c, c, R, 0, TAU);
  b.fill();

  // 원은 항상 그려지고, 이모지 폰트가 없거나 실패해도 위 원은 남는다
  try {
    b.shadowColor = 'rgba(60,25,0,0.28)';
    b.shadowBlur = 2 * ppw;
    b.shadowOffsetY = ppw;
    if (img) {
      const box = R * SPRITE_K;
      const k = Math.min(box / img.naturalWidth, box / img.naturalHeight);
      const w = img.naturalWidth * k;
      const h = img.naturalHeight * k;
      b.drawImage(img, c - w / 2, c - h / 2, w, h);
    } else if (f.emoji) {
      drawEmoji(b, f.emoji, c, c, R * EMOJI_K);
    }
  } catch (e) { /* 원만 남긴다 */ }
  b.shadowColor = 'rgba(0,0,0,0)';

  const sx = c - R * 0.35;
  const sy = c - R * 0.4;
  const shadeG = o.createRadialGradient(sx, sy, 0, sx, sy, R * 1.55);
  shadeG.addColorStop(0, 'rgba(60,20,0,0)');
  shadeG.addColorStop(0.6, 'rgba(60,20,0,0)');
  shadeG.addColorStop(1, 'rgba(60,20,0,0.26)');
  o.fillStyle = shadeG;
  o.beginPath();
  o.arc(c, c, R, 0, TAU);
  o.fill();

  const hx = c - R * 0.4;
  const hy = c - R * 0.45;
  const hr = R * 0.42;
  const hl = o.createRadialGradient(hx, hy, 0, hx, hy, hr);
  hl.addColorStop(0, 'rgba(255,255,255,0.78)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  o.fillStyle = hl;
  o.beginPath();
  o.arc(hx, hy, hr, 0, TAU);
  o.fill();

  // 외곽선은 반지름 안쪽에 그려 실루엣이 물리 반지름과 일치하게 한다
  const lw = (1.5 + f.radius * 0.04) * ppw;
  o.lineWidth = lw;
  o.strokeStyle = shade(f.color, -0.42);
  o.beginPath();
  o.arc(c, c, R - lw / 2, 0, TAU);
  o.stroke();

  return { base, over, c };
}

// 아래쪽 U자(좌/우/바닥) 경로. 바닥 모서리는 캔버스 CSS border-radius 를 따라 둥글게.
function uPath(g, w, h, inset, rr) {
  const r = Math.max(0, Math.min(rr - inset, (w - inset * 2) / 2, (h - inset * 2) / 2));
  g.beginPath();
  g.moveTo(inset, 0);
  g.lineTo(inset, h - inset - r);
  g.arcTo(inset, h - inset, inset + r, h - inset, r);
  g.lineTo(w - inset - r, h - inset);
  g.arcTo(w - inset, h - inset, w - inset, h - inset - r, r);
  g.lineTo(w - inset, 0);
}

function paintBackground(g, w, h, s, d, rr) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#fffdf7');
  grad.addColorStop(0.55, '#fff6dd');
  grad.addColorStop(1, '#ffe8b0');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // 스폰 영역(경계선 위)은 살짝 밝게
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.fillRect(0, 0, w, WORLD.dangerY * s);

  const lw = Math.max(2, 3.5 * d);
  g.lineJoin = 'round';
  g.lineCap = 'butt';
  g.lineWidth = lw;
  g.strokeStyle = '#c98f4f';
  uPath(g, w, h, lw / 2, rr);
  g.stroke();
  g.lineWidth = Math.max(1, d);
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  uPath(g, w, h, lw + g.lineWidth / 2, rr);
  g.stroke();
}

export function createRenderer(gameCanvas, nextCanvas) {
  const ctx = getCtx(gameCanvas);
  const nctx = getCtx(nextCanvas);

  let sized = false;
  let dpr = 1;
  let scale = 1;       // 월드 1단위 = scale 백킹 픽셀
  let bw = 0;
  let bh = 0;
  let lastCW = 0;
  let lastCH = 0;
  let lastDpr = 0;
  let cornerR = 0;
  let bg = null;
  let lastNow = typeof performance !== 'undefined' ? performance.now() : 0;
  let warned = false;

  const cache = new Array(FRUITS.length).fill(null); // null: 미생성, false: 생성 실패
  const images = new Map();                          // level -> { img, ok }
  let nextLevel = null;
  let nextCache = null;                              // { key, sp }

  const particles = [];
  const rings = [];
  const texts = [];

  function getCtx(canvas) {
    try {
      return canvas && canvas.getContext ? canvas.getContext('2d') : null;
    } catch (e) {
      return null;
    }
  }

  function warnOnce(e) {
    if (warned) return;
    warned = true;
    console.warn('[render]', e);
  }

  function spriteImage(level) {
    const url = FRUITS[level].sprite;
    if (!url || typeof Image === 'undefined') return null;
    let e = images.get(level);
    if (!e) {
      e = { img: new Image(), ok: false };
      images.set(level, e);
      e.img.onload = () => {
        e.ok = e.img.naturalWidth > 0;
        cache[level] = null;
        nextCache = null;
        if (levelIndex(nextLevel) === level) redrawNext();
      };
      e.img.src = url; // 실패하면 ok 가 false 로 남아 이모지로 계속 그린다
    }
    return e.ok ? e.img : null;
  }

  function getSprite(level) {
    let sp = cache[level];
    if (sp === null) {
      try {
        sp = buildSprite(level, scale, spriteImage(level));
      } catch (e) {
        sp = false;
      }
      cache[level] = sp || false;
    }
    return sp || null;
  }

  function resize() {
    if (!ctx) return;
    try {
      const cw = gameCanvas.clientWidth;
      const ch = gameCanvas.clientHeight;
      if (!(cw > 0) || !(ch > 0)) return;
      const d = currentDpr();
      const w = Math.max(1, Math.round(cw * d));
      const h = Math.max(1, Math.round(ch * d));
      lastCW = cw;
      lastCH = ch;
      lastDpr = d;
      if (sized && w === bw && h === bh && d === dpr) return;
      dpr = d;
      bw = w;
      bh = h;
      if (gameCanvas.width !== w) gameCanvas.width = w;
      if (gameCanvas.height !== h) gameCanvas.height = h;
      scale = w / WORLD.width;
      cache.fill(null); // 비트맵은 현재 픽셀 스케일 기준이라 무효화
      nextCache = null;
      try {
        cornerR = (parseFloat(getComputedStyle(gameCanvas).borderBottomLeftRadius) || 0) * dpr;
      } catch (e) {
        cornerR = 0;
      }
      try {
        bg = makeCanvas(w, h);
        const bgc = bg.getContext('2d');
        if (bgc) paintBackground(bgc, w, h, scale, dpr, cornerR);
        else bg = null;
      } catch (e) {
        bg = null;
      }
      sized = true;
      // 캔버스는 크기를 바꾸면 비워지므로 바로 배경을 깔아 깜빡임을 줄인다
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (bg) ctx.drawImage(bg, 0, 0);
        else paintBackground(ctx, bw, bh, scale, dpr, cornerR);
      }
      redrawNext();
    } catch (e) {
      warnOnce(e);
    }
  }

  function clientToWorld(clientX, clientY) {
    const r = gameCanvas && gameCanvas.getBoundingClientRect();
    if (!r || !(r.width > 0) || !(r.height > 0)) return { x: WORLD.width / 2, y: 0 };
    return {
      x: ((clientX - r.left) / r.width) * WORLD.width,
      y: ((clientY - r.top) / r.height) * WORLD.height,
    };
  }

  // ----- 그리기 -----

  function drawDangerLine(g, now, danger) {
    const y = WORLD.dangerY;
    const W = WORLD.width;
    g.lineCap = 'butt';
    if (danger >= 0.5) {
      const k = (danger - 0.5) * 2;
      const pulse = 0.5 + 0.5 * Math.sin(now * BLINK_RAD_PER_MS);
      const glow = g.createLinearGradient(0, y - 34, 0, y);
      glow.addColorStop(0, 'rgba(229,57,53,0)');
      glow.addColorStop(1, `rgba(229,57,53,${(0.1 + 0.22 * k) * pulse})`);
      g.fillStyle = glow;
      g.fillRect(0, y - 34, W, 34);
      g.strokeStyle = `rgba(229,57,53,${0.25 + 0.75 * pulse * (0.65 + 0.35 * k)})`;
      g.lineWidth = 2 + 2 * k * pulse;
    } else {
      g.strokeStyle = 'rgba(150,105,60,0.5)';
      g.lineWidth = 2;
    }
    g.setLineDash(DASH);
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
    g.setLineDash(NO_DASH);
  }

  // 변환을 직접 지정하므로 호출 뒤에는 월드 변환을 다시 걸어야 한다
  function drawFruit(g, level, x, y, angle, k) {
    const sp = getSprite(level);
    const px = x * scale;
    const py = y * scale;
    if (!sp) {
      g.setTransform(scale * k, 0, 0, scale * k, px, py);
      g.fillStyle = FRUITS[level].color;
      g.strokeStyle = shade(FRUITS[level].color, -0.4);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(0, 0, FRUITS[level].radius, 0, TAU);
      g.fill();
      g.stroke();
      return;
    }
    const cs = Math.cos(angle) * k;
    const sn = Math.sin(angle) * k;
    g.setTransform(cs, sn, -sn, cs, px, py);
    g.drawImage(sp.base, -sp.c, -sp.c);
    g.setTransform(k, 0, 0, k, px, py);
    g.drawImage(sp.over, -sp.c, -sp.c);
  }

  // x 위치에서 수직으로 떨어뜨렸을 때 처음 닿는 표면의 y
  function landingY(x, fromY, bodies) {
    let y = WORLD.height;
    if (!bodies) return y;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b) continue;
      const lv = levelIndex(b.level);
      if (lv < 0 || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      const r = FRUITS[lv].radius;
      const dx = Math.abs(b.x - x);
      if (dx >= r) continue;
      const top = b.y - Math.sqrt(r * r - dx * dx);
      if (top > fromY && top < y) y = top;
    }
    return y;
  }

  function drawHeld(g, held, bodies) {
    const lv = levelIndex(held.level);
    if (lv < 0 || !Number.isFinite(held.x)) return;
    const r = FRUITS[lv].radius;
    const x = clamp(held.x, r, WORLD.width - r);
    const y = WORLD.spawnY;
    const endY = landingY(x, y + r, bodies);
    if (endY > y + r) {
      g.strokeStyle = 'rgba(110,75,40,0.3)';
      g.lineWidth = 2;
      g.lineCap = 'round';
      g.setLineDash([3, 8]);
      g.beginPath();
      g.moveTo(x, y + r + 2);
      g.lineTo(x, endY);
      g.stroke();
      g.setLineDash(NO_DASH);
      g.lineCap = 'butt';
      g.fillStyle = 'rgba(110,75,40,0.4)';
      g.beginPath();
      g.arc(x, endY, 3, 0, TAU);
      g.fill();
    }
    drawFruit(g, lv, x, y, 0, 1);
    g.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function drawEffects(g, now) {
    g.setTransform(scale, 0, 0, scale, 0, 0);

    let w = 0;
    for (let i = 0; i < rings.length; i++) {
      const e = rings[i];
      if (e.born === null) e.born = now;
      const t = Math.max(0, now - e.born) / e.life;
      if (t >= 1) continue;
      rings[w++] = e;
      const k = 1 - (1 - t) * (1 - t);
      g.globalAlpha = (1 - t) * 0.85;
      g.strokeStyle = e.color;
      g.lineWidth = e.w * (1 - t) + 0.5;
      g.beginPath();
      g.arc(e.x, e.y, e.r0 + (e.r1 - e.r0) * k, 0, TAU);
      g.stroke();
    }
    rings.length = w;

    w = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.born === null) p.born = now;
      const age = Math.max(0, now - p.born);
      if (age >= p.life) continue;
      particles[w++] = p;
      const t = age / 1000;
      const k = age / p.life;
      g.globalAlpha = (1 - k) * (1 - k * 0.3);
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(p.x + p.vx * t, p.y + p.vy * t + 0.5 * p.g * t * t, p.size * (1 - 0.55 * k), 0, TAU);
      g.fill();
    }
    particles.length = w;

    w = 0;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    for (let i = 0; i < texts.length; i++) {
      const e = texts[i];
      if (e.born === null) e.born = now;
      const age = Math.max(0, now - e.born);
      if (age >= e.life) continue;
      texts[w++] = e;
      const k = age / e.life;
      const rise = 1 - (1 - k) * (1 - k);
      const pop = age < 140 ? 0.6 + 0.55 * (age / 140) : age < 240 ? 1.15 - 0.15 * ((age - 140) / 100) : 1;
      g.globalAlpha = k < 0.7 ? 1 : (1 - k) / 0.3;
      g.setTransform(scale * pop, 0, 0, scale * pop, e.x * scale, (e.y - e.rise * rise) * scale);
      g.font = `800 ${e.size}px ${UI_FONT}`;
      g.lineWidth = e.size * 0.26;
      g.strokeStyle = e.stroke;
      g.strokeText(e.text, 0, 0);
      g.fillStyle = e.fill;
      g.fillText(e.text, 0, 0);
    }
    texts.length = w;

    g.globalAlpha = 1;
    g.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function render(frame) {
    if (!sized || gameCanvas.clientWidth !== lastCW || gameCanvas.clientHeight !== lastCH || currentDpr() !== lastDpr) {
      resize();
    }
    if (!sized) return;

    const g = ctx;
    const now = num(frame.now, lastNow);
    lastNow = now;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    if (bg) g.drawImage(bg, 0, 0);
    else paintBackground(g, bw, bh, scale, dpr, cornerR);

    g.setTransform(scale, 0, 0, scale, 0, 0);
    drawDangerLine(g, now, clamp(num(frame.danger), 0, 1));

    const bodies = Array.isArray(frame.bodies) ? frame.bodies : null;
    if (bodies) {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (!b) continue;
        const lv = levelIndex(b.level);
        if (lv < 0 || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
        drawFruit(g, lv, b.x, b.y, num(b.angle), popScale(b.popAge));
      }
      g.setTransform(scale, 0, 0, scale, 0, 0);
    }

    if (frame.held) drawHeld(g, frame.held, bodies);

    drawEffects(g, now);

    if (frame.state === 'GAME_OVER') {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = 'rgba(70,35,10,0.32)';
      g.fillRect(0, 0, bw, bh);
    }
  }

  function draw(frame) {
    if (!ctx) return;
    try {
      render(frame || {});
    } catch (e) {
      warnOnce(e);
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.setLineDash(NO_DASH);
      } catch (e2) { /* 무시 */ }
    }
  }

  // ----- Next 미리보기 -----

  function nextSprite(lv, w, h) {
    const f = FRUITS[lv];
    // 크기 차이는 남기되 가장 작은 과일도 알아볼 수 있게 56%~94% 로 압축한다
    const rmin = FRUITS[0].radius;
    const rmax = FRUITS[Math.min(MAX_DROP_LEVEL, LAST_LEVEL)].radius;
    const t = clamp((f.radius - rmin) / (rmax - rmin || 1), 0, 1);
    const ppw = ((0.56 + 0.38 * t) * Math.min(w, h)) / (2 * f.radius);
    const key = `${lv}:${ppw.toFixed(4)}`;
    if (!nextCache || nextCache.key !== key) {
      let sp = null;
      try {
        sp = buildSprite(lv, ppw, spriteImage(lv));
      } catch (e) {
        sp = null;
      }
      nextCache = { key, sp };
    }
    return nextCache.sp;
  }

  function redrawNext() {
    if (!nctx) return;
    try {
      const cw = nextCanvas.clientWidth;
      const ch = nextCanvas.clientHeight;
      if (cw > 0 && ch > 0) {
        const d = currentDpr();
        const tw = Math.max(1, Math.round(cw * d));
        const th = Math.max(1, Math.round(ch * d));
        if (nextCanvas.width !== tw) nextCanvas.width = tw;
        if (nextCanvas.height !== th) nextCanvas.height = th;
      }
      const w = nextCanvas.width;
      const h = nextCanvas.height;
      nctx.setTransform(1, 0, 0, 1, 0, 0);
      nctx.clearRect(0, 0, w, h);
      const lv = levelIndex(nextLevel);
      if (lv < 0) return;
      const sp = nextSprite(lv, w, h);
      if (!sp) return;
      const ox = Math.round(w / 2) - sp.c;
      const oy = Math.round(h / 2) - sp.c;
      nctx.drawImage(sp.base, ox, oy);
      nctx.drawImage(sp.over, ox, oy);
    } catch (e) {
      warnOnce(e);
    }
  }

  function drawNext(level) {
    nextLevel = level;
    redrawNext();
  }

  // ----- 이펙트 -----

  function addMergeEffect(e) {
    try {
      if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) return;
      const lv = Math.max(0, levelIndex(e.level));
      const f = FRUITS[lv];
      const bonus = !!e.bonus;
      const r = f.radius;

      const n = bonus ? 28 : 10 + Math.min(6, Math.round(lv * 0.6));
      const spread = (bonus ? 1.4 : 1) * (0.8 + r / 120);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const sp = (70 + Math.random() * 130) * spread;
        particles.push({
          x: e.x + Math.cos(a) * r * 0.6,
          y: e.y + Math.sin(a) * r * 0.6,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 50,
          g: 320,
          born: null,
          life: 420 + Math.random() * 380,
          size: Math.min(8, (2.4 + Math.random() * 2.6) * (0.75 + r / 90)),
          color: bonus && i % 3 !== 0 ? GOLD[i % GOLD.length] : shade(f.color, (Math.random() - 0.35) * 0.7),
        });
      }
      rings.push({
        x: e.x, y: e.y, born: null, life: bonus ? 520 : 340,
        r0: r * 0.8, r1: r * (bonus ? 2.2 : 1.5) + 10,
        color: bonus ? '#ffc107' : f.color, w: bonus ? 6 : 4,
      });
      if (bonus) {
        rings.push({ x: e.x, y: e.y, born: null, life: 700, r0: r * 0.5, r1: r * 3, color: '#fff176', w: 4 });
      }

      if (Number.isFinite(e.points)) {
        texts.push({
          x: 0, y: 0, born: null,
          text: `+${Math.round(e.points)}`,
          size: bonus ? 34 : clamp(15 + lv * 1.3, 15, 28),
          life: bonus ? 1500 : 900,
          rise: bonus ? 64 : 44,
          fill: bonus ? '#ffd54f' : '#ffffff',
          stroke: bonus ? '#8d4a00' : 'rgba(110,55,15,0.85)',
        });
        const t = texts[texts.length - 1];
        const half = t.text.length * t.size * 0.3 + 4;
        t.x = clamp(e.x, half, WORLD.width - half);
        t.y = e.y - r * 0.4;
      }

      if (particles.length > MAX_PARTICLES) particles.splice(0, particles.length - MAX_PARTICLES);
      if (rings.length > MAX_RINGS) rings.splice(0, rings.length - MAX_RINGS);
      if (texts.length > MAX_TEXTS) texts.splice(0, texts.length - MAX_TEXTS);
    } catch (err) {
      warnOnce(err);
    }
  }

  function addDropEffect(e) {
    try {
      if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) return;
      const lv = Math.max(0, levelIndex(e.level));
      const f = FRUITS[lv];
      rings.push({
        x: e.x, y: e.y, born: null, life: 380,
        r0: f.radius * 0.7, r1: f.radius * 1.4 + 6,
        color: withAlpha(f.color, 0.8), w: 3,
      });
      for (let i = 0; i < 6; i++) {
        const a = Math.PI * (1 + i / 5); // 위쪽 반원으로 퍼진다 (y 는 아래가 +)
        const sp = 30 + Math.random() * 50;
        particles.push({
          x: e.x + (Math.random() - 0.5) * f.radius,
          y: e.y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp * 0.5 - 12,
          g: 60,
          born: null,
          life: 300 + Math.random() * 200,
          size: 1.6 + Math.random() * 1.6,
          color: 'rgba(176,138,90,0.85)',
        });
      }
      if (particles.length > MAX_PARTICLES) particles.splice(0, particles.length - MAX_PARTICLES);
      if (rings.length > MAX_RINGS) rings.splice(0, rings.length - MAX_RINGS);
    } catch (err) {
      warnOnce(err);
    }
  }

  return { resize, clientToWorld, draw, drawNext, addMergeEffect, addDropEffect };
}
