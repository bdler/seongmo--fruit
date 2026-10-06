// 브라우저 e2e 공용 도우미 (smoke.mjs: 개발용 정적 페이지, gas.mjs: Apps Script 배포 모의). 시나리오 코드가 아닌 것만 둔다.
// page 인자는 Playwright 의 Page 또는 Frame 이다 (evaluate/locator/waitForFunction/click 만 쓴다). 마우스/키보드는 여기에 없다.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { FRUITS, WORLD } from '../../js/config.js';

export async function launchBrowser() {
  const headless = !process.argv.includes('--headed');
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  return chromium.launch({ headless, executablePath });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 조건이 참이 될 때까지 기다린다 (Node 쪽 상태를 기다릴 때 쓴다)
export async function until(fn, what, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) assert.fail(`시간 안에 ${what} 이(가) 일어나지 않음`);
    await sleep(25);
  }
}

export const bodiesOf = (page) => page.evaluate(() => window.__fruit.bodies());
export const stateOf = (page) => page.evaluate(() => window.__fruit.getState());
export const scoreOfPage = (page) => page.evaluate(() => window.__fruit.getScore());
export const advance = (page, ms) => page.evaluate((n) => window.__fruit.advance(n), ms);
export const pause = (page) => page.evaluate(() => window.__fruit.pause());
export const spawn = (page, level, x, y) => page.evaluate(([l, px, py]) => window.__fruit.spawn(l, px, py), [level, x, y]);
export const gameInfo = (page) => page.evaluate(() => {
  const g = window.__fruit.game;
  return { state: g.state, score: g.score, drops: g.drops, maxLevel: g.maxLevel, cleared: g.cleared, danger: g.danger };
});
export const text = (page, sel) => page.locator(sel).innerText();
export const isVisible = (page, sel) => page.locator(sel).isVisible();
export const lsGet = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

export const inBox = (b, tol = 4) => {
  const r = FRUITS[b.level].radius;
  return b.x >= r - tol && b.x <= WORLD.width - r + tol && b.y <= WORLD.height - r + tol && Number.isFinite(b.x + b.y);
};

// advance 를 쪼개 진행하면서 모든 스텝에서 상자 안에 있는지 확인한다
export async function settleChecked(page, totalMs, chunk = 100) {
  for (let t = 0; t < totalMs; t += chunk) {
    await advance(page, chunk);
    for (const b of await bodiesOf(page)) assert.ok(inBox(b), `상자를 벗어남: ${JSON.stringify(b)}`);
  }
}

export async function layoutMetrics(page) {
  return page.evaluate(() => {
    const rect = (sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
    };
    const de = document.documentElement;
    const canvas = document.getElementById('game-canvas');
    const lis = [...document.querySelectorAll('#evolution-list > li')].map((li) => {
      const b = li.getBoundingClientRect();
      return { l: b.left, r: b.right, cy: (b.top + b.bottom) / 2, w: b.width };
    });
    const evo = document.getElementById('evolution-list');
    return {
      vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
      canvas: rect('#game-canvas'), stage: rect('#stage'), hud: rect('#hud'), evo: rect('#evolution'),
      mute: rect('#btn-mute'), next: rect('#next-canvas'),
      canvasPx: { w: canvas.width, h: canvas.height },
      scroll: { x: scrollX, y: scrollY, dw: de.scrollWidth, dh: de.scrollHeight, bw: document.body.scrollWidth, bh: document.body.scrollHeight },
      evoOverflow: evo.scrollWidth > evo.clientWidth + 1,
      lis,
    };
  });
}

// opts.minCanvasW: 게임판 최소 폭. opts.sideBySide: 가로 모드(HUD/진화 줄이 게임판 옆에 있어야 함)
export function assertLayout(m, label, { minCanvasW = 200, sideBySide = false } = {}) {
  const eps = 0.75;
  const within = (name, r) => {
    assert.ok(r.l >= -eps && r.t >= -eps && r.r <= m.vw + eps && r.b <= m.vh + eps, `${label}: ${name} 이(가) 화면 밖 ${JSON.stringify(r)} / ${m.vw}x${m.vh}`);
  };
  for (const name of ['canvas', 'stage', 'hud', 'evo', 'mute', 'next']) within(name, m[name]);
  assert.ok(Math.abs(m.canvas.w / m.canvas.h - 2 / 3) < 0.01, `${label}: 캔버스 비율 2:3 아님 (${m.canvas.w}x${m.canvas.h})`);
  assert.ok(m.canvas.w > minCanvasW, `${label}: 캔버스가 너무 작음 ${m.canvas.w}`);
  if (sideBySide) {
    assert.ok(m.hud.l >= m.stage.r - eps && m.evo.l >= m.stage.r - eps, `${label}: HUD/진화 줄이 게임판과 겹침`);
  }
  const wantW = m.canvas.w * Math.min(m.dpr, 3);
  assert.ok(Math.abs(m.canvasPx.w - wantW) <= 1.5, `${label}: 캔버스 백킹 해상도 ${m.canvasPx.w} != css*dpr ${wantW}`);
  assert.ok(m.scroll.dw <= m.vw && m.scroll.dh <= m.vh && m.scroll.bw <= m.vw && m.scroll.bh <= m.vh, `${label}: 페이지가 스크롤됨 ${JSON.stringify(m.scroll)}`);
  assert.equal(m.scroll.x + m.scroll.y, 0, `${label}: 스크롤 위치가 0 이 아님`);
  assert.equal(m.lis.length, FRUITS.length, `${label}: 진화 줄 항목 수`);
  assert.ok(!m.evoOverflow, `${label}: 진화 줄이 넘침`);
  for (let i = 0; i < m.lis.length; i++) {
    assert.ok(Math.abs(m.lis[i].cy - m.lis[0].cy) < 8, `${label}: 진화 줄이 줄바꿈됨 (li ${i})`);
    if (i) assert.ok(m.lis[i].l >= m.lis[i - 1].r - 0.5, `${label}: 진화 줄 항목이 겹침 (li ${i})`);
  }
  assert.ok(m.lis[m.lis.length - 1].r <= m.evo.r + 0.5 && m.lis[0].l >= m.evo.l - 0.5, `${label}: 진화 항목이 줄 밖으로 나감`);
}
