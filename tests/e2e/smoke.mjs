// 브라우저 end-to-end 스모크 테스트. 헤드리스 Chromium(Playwright)으로 실제 index.html 을 띄워 검증한다.
// - 자체 정적 서버(무작위 포트)를 띄우므로 여러 번 동시에 돌려도 충돌하지 않는다.
// - CDN 의 Matter.js 는 node_modules 의 같은 버전으로 대체하므로 네트워크가 필요 없다.
// - ?debug 훅(window.__fruit)으로 시뮬레이션을 결정적으로 진행한다.
//
// 사용: node tests/e2e/smoke.mjs [--only=a,c] [--headed]   (환경변수 CHROMIUM_PATH 로 브라우저 지정 가능)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import {
  FRUITS,
  LAST_LEVEL,
  WORLD,
  TIMING,
  STORAGE_KEYS,
  WATERMELON_PAIR_BONUS,
  scoreOf,
} from '../../js/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MATTER_FILE = path.join(ROOT, 'node_modules/matter-js/build/matter.min.js');
const CDN_MATTER = 'https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.19.0/matter.min.js';
const FAKE_API_URL = 'https://script.google.com/macros/s/TEST/exec';
const FAKE_API_RE = /^https:\/\/script\.google\.com\/macros\/s\/TEST\/exec(\?.*)?$/;
const API_URL_LINE_RE = /^export const API_URL = .*;$/m;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const XSS_NICK = '<img src=x onerror=alert(1)>';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ───────────────────────── 하네스 ─────────────────────────

export async function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT + path.sep) || /(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(path.relative(ROOT, file))) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const data = await fs.readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };
}

export async function launchBrowser() {
  const headless = !process.argv.includes('--headed');
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  return chromium.launch({ headless, executablePath });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 조건이 참이 될 때까지 기다린다 (Node 쪽 상태를 기다릴 때 쓴다)
async function until(fn, what, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) assert.fail(`시간 안에 ${what} 이(가) 일어나지 않음`);
    await sleep(25);
  }
}

// 가짜 Apps Script. GET ranking / POST submit 프로토콜을 흉내 내고 요청을 기록한다.
export function createFakeApi({ rows = [], postQueue = [] } = {}) {
  const api = {
    rows,
    postQueue, // 'ok' | 'server_busy' | 'throttled' | 'invalid_nickname' | 'abort' | 'html' (한 번씩 소진, 비면 ok)
    getDelayMs: 0, // 응답을 늦춰서 '늦게 도착한 이전 응답' 경합을 만든다
    postDelayMs: 0,
    gets: [],
    posts: [],
    async handle(route) {
      const req = route.request();
      const headers = {
        'access-control-allow-origin': '*',
        'content-type': 'application/json; charset=utf-8',
      };
      const json = (obj) => route.fulfill({ status: 200, headers, body: JSON.stringify(obj) });
      if (req.method() === 'OPTIONS') {
        api.preflight = (api.preflight ?? 0) + 1;
        await route.fulfill({ status: 204, headers: { ...headers, 'access-control-allow-headers': '*' } });
        return;
      }
      if (req.method() === 'GET') {
        const u = new URL(req.url());
        api.gets.push(u);
        const limit = Number(u.searchParams.get('limit')) || 10;
        const sorted = [...api.rows].sort((a, b) => b.score - a.score).slice(0, limit);
        if (api.getDelayMs) await sleep(api.getDelayMs);
        await json({ ok: true, data: sorted });
        return;
      }
      const headersAll = await req.allHeaders();
      const post = { headers: headersAll, raw: req.postData() ?? '' };
      try { post.body = JSON.parse(post.raw); } catch { post.body = null; }
      api.posts.push(post);
      if (api.postDelayMs) await sleep(api.postDelayMs);
      const mode = api.postQueue.shift() ?? 'ok';
      if (mode === 'abort') return route.abort('failed');
      if (mode === 'html') {
        return route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'text/html' }, body: '<html>login</html>' });
      }
      if (mode !== 'ok') return json({ ok: false, error: mode });
      if (post.body) {
        api.rows.push({ nickname: post.body.nickname, score: post.body.score, maxLevel: post.body.maxLevel, at: Date.now() });
      }
      return json({ ok: true });
    },
  };
  return api;
}

export function sampleRows(n = 5, withXss = true) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ nickname: `플레이어${i + 1}`, score: 5000 - i * 321, maxLevel: 8 - (i % 5), at: 1700000000000 + i });
  }
  if (withXss) rows[1] = { nickname: XSS_NICK, score: 4321, maxLevel: 7, at: 1700000001000 };
  return rows;
}

// 새 컨텍스트 + 페이지를 만들고 오류 수집기를 붙인다.
export async function openPage(browser, server, o = {}) {
  const {
    viewport = { width: 1280, height: 720 },
    mobile = false,
    deviceScaleFactor = mobile ? 3 : 1,
    fakeApi = null, // 주면 API_URL 을 가짜 URL 로 바꾸고 해당 URL 을 가로챈다. 없으면 API_URL 은 항상 '' (오프라인)
    storage = {}, // 페이지 로드 전에 넣어 둘 localStorage (최초 1회만)
    ignore = [], // 허용할 콘솔 오류/요청 실패 메시지 패턴
    reducedMotion = 'no-preference',
  } = o;

  // 배포 뒤 config.js 에 운영 URL 이 들어가도 테스트가 외부로 나가거나 깨지지 않도록 모든 시나리오에서 API_URL 을 고정한다.
  const configSrc = await fs.readFile(path.join(ROOT, 'js/config.js'), 'utf8');
  assert.match(configSrc, API_URL_LINE_RE, 'config.js 의 API_URL 선언 형태가 바뀌었다 (테스트가 치환하지 못함)');
  const patchedConfig = configSrc.replace(API_URL_LINE_RE, () => `export const API_URL = '${fakeApi ? FAKE_API_URL : ''}';`);

  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor, locale: 'ko-KR', reducedMotion });

  await ctx.route(CDN_MATTER, (route) => route.fulfill({ path: MATTER_FILE, contentType: 'text/javascript' }));
  await ctx.route('**/js/config.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript; charset=utf-8', headers: { 'cache-control': 'no-store' }, body: patchedConfig,
  }));
  if (fakeApi) await ctx.route(FAKE_API_RE, (route) => fakeApi.handle(route));
  if (Object.keys(storage).length) {
    await ctx.addInitScript((items) => {
      try {
        if (sessionStorage.getItem('__e2e_seeded')) return;
        sessionStorage.setItem('__e2e_seeded', '1');
        for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
      } catch { /* ignore */ }
    }, storage);
  }

  const page = await ctx.newPage();
  const env = { ctx, page, server, issues: [], requests: [], ignore: [...ignore], dialogs: [] };
  const push = (kind, text) => env.issues.push({ kind, text });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') push(`console.${m.type()}`, `${m.text()} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => push('pageerror', e.stack || e.message));
  page.on('requestfailed', (r) => {
    if (r.url().startsWith('data:')) return; // 파비콘 data URI
    push('requestfailed', `${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) push('http', `${r.status()} ${r.url()}`);
  });
  page.on('request', (r) => env.requests.push({ method: r.method(), url: r.url(), headers: r.headers() }));
  page.on('dialog', (d) => {
    env.dialogs.push(d.message());
    push('dialog', d.message());
    d.dismiss().catch(() => {});
  });
  return env;
}

export function remainingIssues(env) {
  return env.issues.filter((i) => !env.ignore.some((re) => re.test(i.text)));
}

export async function loadGame(env, search = '?debug') {
  await env.page.goto(`${env.server.origin}/${search}`);
  if (new URLSearchParams(search).has('debug')) await env.page.waitForFunction(() => !!window.__fruit);
  await env.page.waitForFunction(() => document.getElementById('game-canvas').width > 100);
  await env.page.evaluate(() => document.fonts?.ready);
}

// ───────────────────────── 시나리오 도우미 ─────────────────────────

const bodiesOf = (page) => page.evaluate(() => window.__fruit.bodies());
const stateOf = (page) => page.evaluate(() => window.__fruit.getState());
const scoreOfPage = (page) => page.evaluate(() => window.__fruit.getScore());
const advance = (page, ms) => page.evaluate((n) => window.__fruit.advance(n), ms);
const pause = (page) => page.evaluate(() => window.__fruit.pause());
const spawn = (page, level, x, y) => page.evaluate(([l, px, py]) => window.__fruit.spawn(l, px, py), [level, x, y]);
const gameInfo = (page) => page.evaluate(() => {
  const g = window.__fruit.game;
  return { state: g.state, score: g.score, drops: g.drops, maxLevel: g.maxLevel, cleared: g.cleared, danger: g.danger };
});
const text = (page, sel) => page.locator(sel).innerText();
const isVisible = (page, sel) => page.locator(sel).isVisible();
const lsGet = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

async function startGame(page) {
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__fruit.getState() === 'READY');
}

async function restartGame(page) {
  await page.click('#btn-restart');
  await page.waitForFunction(() => window.__fruit.getState() === 'READY');
}

async function worldToClient(page, wx, wy = 300) {
  const box = await page.locator('#game-canvas').boundingBox();
  return { x: box.x + (wx / WORLD.width) * box.width, y: box.y + (wy / WORLD.height) * box.height };
}

async function mouseDrop(page, wx) {
  const p = await worldToClient(page, wx);
  await page.mouse.move(p.x - 30, p.y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
}

// 판을 끝내기 위한 '경계선 위에 고정된 과일'. static 이라 움직이지 않고, 생성 시각은 지금이다.
function pinAboveLine(page, level = 3, x = 200) {
  return page.evaluate(([l, px]) => {
    const info = window.__fruit.spawn(l, px, 40);
    const b = window.__fruit.physics.bodies().find((body) => body.id === info.id);
    Matter.Body.setStatic(b, true);
    return info.id;
  }, [level, x]);
}

const inBox = (b, tol = 4) => {
  const r = FRUITS[b.level].radius;
  return b.x >= r - tol && b.x <= WORLD.width - r + tol && b.y <= WORLD.height - r + tol && Number.isFinite(b.x + b.y);
};

// advance 를 쪼개 진행하면서 모든 스텝에서 상자 안에 있는지 확인한다
async function settleChecked(page, totalMs, chunk = 100) {
  for (let t = 0; t < totalMs; t += chunk) {
    await advance(page, chunk);
    for (const b of await bodiesOf(page)) assert.ok(inBox(b), `상자를 벗어남: ${JSON.stringify(b)}`);
  }
}

// physics 가 보고하는 합치기 이벤트를 기록한다 (game.applyMerge 를 감싼다)
function recordMerges(page) {
  return page.evaluate(() => {
    const g = window.__fruit.game;
    const orig = g.applyMerge;
    window.__merges = [];
    g.applyMerge = (evt) => {
      window.__merges.push({ level: evt.level, bonus: !!evt.bonus });
      return orig(evt);
    };
  });
}
const mergesOf = (page) => page.evaluate(() => window.__merges);

const massOf = (bodies) => bodies.reduce((s, b) => s + 2 ** b.level, 0);

async function layoutMetrics(page) {
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
function assertLayout(m, label, { minCanvasW = 200, sideBySide = false } = {}) {
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

// ───────────────────────── 시나리오 ─────────────────────────

const scenarios = [];
const scenario = (id, title, opts, fn) => scenarios.push({ id, title, opts, fn });

scenario('a', '로드: 오류 없음, 시작 화면, Matter 존재, 프로덕션엔 디버그 훅 없음', {}, async (env) => {
  const { page } = env;
  await loadGame(env);
  assert.equal(await page.title(), '수박 합치기');
  assert.ok(await isVisible(page, '#screen-start'), '시작 화면이 보여야 함');
  assert.ok(await page.locator('#btn-start').isEnabled());
  assert.ok(!(await isVisible(page, '#start-error')));
  assert.equal(await page.evaluate(() => typeof Matter), 'object');
  assert.equal(await page.evaluate(() => Matter.version), '0.19.0');
  assert.equal(await page.locator('#evolution-list > li').count(), FRUITS.length);
  assert.equal(await stateOf(page), 'IDLE');
  // 캔버스에 실제로 무언가 그려졌다 (배경은 불투명)
  const alpha = await page.evaluate(() => {
    const c = document.getElementById('game-canvas');
    return c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data[3];
  });
  assert.equal(alpha, 255, '캔버스가 비어 있음');
  // 핀치 확대를 막으면 저시력 사용자가 쓸 수 없다 (WCAG 1.4.4). 확대 방지는 CSS touch-action 으로 충분하다.
  const viewportMeta = await page.locator('meta[name=viewport]').getAttribute('content');
  assert.ok(!/user-scalable|maximum-scale/i.test(viewportMeta), `뷰포트 메타가 확대를 막음: ${viewportMeta}`);
  // 디버그 훅은 ?debug 파라미터가 있을 때만 (이름에 'debug' 가 들어 있을 뿐인 쿼리는 해당 없음)
  for (const search of ['', '?nodebug=1', '?utm_campaign=debug-day', '?debugger']) {
    await page.goto(`${env.server.origin}/${search}`);
    await page.waitForFunction(() => document.getElementById('game-canvas').width > 100);
    assert.equal(await page.evaluate(() => typeof window.__fruit), 'undefined', `${search || '(쿼리 없음)'} 에서 디버그 훅이 노출됨`);
  }
  await page.goto(`${env.server.origin}/?x=1&debug=1`);
  await page.waitForFunction(() => !!window.__fruit);
});

scenario('b', '시작 → 마우스 이동+클릭으로 드롭, 상자 안에 안착, 쿨다운', {}, async (env) => {
  const { page } = env;
  await loadGame(env);
  await startGame(page);
  assert.equal((await bodiesOf(page)).length, 0, '시작 버튼 클릭이 드롭으로 이어지면 안 됨');
  assert.equal((await gameInfo(page)).drops, 0);

  // 실시간 루프: 드롭하면 실제로 떨어진다
  await mouseDrop(page, 123);
  let bs = await bodiesOf(page);
  assert.equal(bs.length, 1);
  assert.ok(Math.abs(bs[0].x - 123) < 2.5, `드롭 x ${bs[0].x}`);
  assert.equal(await stateOf(page), 'COOLDOWN');
  await page.waitForFunction(() => window.__fruit.bodies()[0].y > 250, null, { timeout: 5000 });

  // 결정적 진행: 상자를 벗어나지 않고 안착한다
  await pause(page);
  await settleChecked(page, 6000);
  bs = await bodiesOf(page);
  assert.equal(bs.length, 1);
  const r = FRUITS[bs[0].level].radius;
  assert.ok(Math.abs(bs[0].y - (WORLD.height - r)) < 3, `바닥에 닿지 않음 y=${bs[0].y}`);
  assert.ok(Math.hypot(bs[0].vx, bs[0].vy) < 0.1, '정지하지 않음');
  assert.equal(await stateOf(page), 'READY');

  // 왼쪽 가장자리 밖을 눌러도 벽 안쪽으로 보정된다
  await mouseDrop(page, 1);
  bs = (await bodiesOf(page)).sort((p, q) => p.id - q.id);
  assert.equal(bs.length, 2);
  assert.ok(Math.abs(bs[1].x - FRUITS[bs[1].level].radius) < 0.5, `왼쪽 보정 x=${bs[1].x}`);

  // 쿨다운 중 입력 무시 → 500ms 후 다시 가능
  await mouseDrop(page, 300);
  await page.keyboard.press('Space');
  assert.equal((await bodiesOf(page)).length, 2, '쿨다운 중에 드롭됨');
  await advance(page, TIMING.dropCooldown);
  assert.equal(await stateOf(page), 'READY');
  await mouseDrop(page, 300);
  assert.equal((await bodiesOf(page)).length, 3);
  assert.equal((await gameInfo(page)).drops, 3);
  await settleChecked(page, 5000);
});

scenario('b2', '가장자리: 왼쪽/오른쪽 끝을 눌러도 과일이 벽 안쪽(반지름만큼)에 놓인다', {}, async (env) => {
  const { page } = env;
  await loadGame(env);
  await startGame(page);
  await pause(page);
  for (const [wx, side] of [[1, 'left'], [399, 'right'], [399.9, 'right']]) {
    await mouseDrop(page, wx);
    const b = (await bodiesOf(page)).sort((p, q) => q.id - p.id)[0];
    const r = FRUITS[b.level].radius;
    const want = side === 'left' ? r : WORLD.width - r;
    assert.ok(Math.abs(b.x - want) < 0.5, `${side} 끝 보정 x=${b.x} (기대 ${want})`);
    await advance(page, TIMING.dropCooldown);
  }
  await settleChecked(page, 3000);
});

scenario('c', '결정적 합치기: 쌍, 3개, 연쇄 사다리 (중복 없음, 점수)', {}, async (env) => {
  const { page } = env;
  await loadGame(env);
  await startGame(page);
  await pause(page);
  await recordMerges(page);

  // c1: 같은 단계 한 쌍 → 정확히 한 단계 위 과일 1개
  const L = 3;
  const rL = FRUITS[L].radius;
  await spawn(page, L, 160, WORLD.height - rL);
  await spawn(page, L, 160 + 2 * rL - 2, WORLD.height - rL);
  await advance(page, 100);
  let bs = await bodiesOf(page);
  assert.equal(bs.length, 1, `합쳐진 뒤 과일 수 ${bs.length}`);
  assert.equal(bs[0].level, L + 1);
  assert.equal(await scoreOfPage(page), scoreOf(L + 1));
  assert.ok(Math.abs(bs[0].x - (160 + rL - 1)) < 3, `중간 지점에 생성: x=${bs[0].x}`);
  await advance(page, 2000);
  bs = await bodiesOf(page);
  assert.equal(bs.length, 1, '시간이 지나도 중복 생성/소멸이 없어야 함');
  assert.equal(new Set(bs.map((b) => b.id)).size, bs.length);
  assert.equal((await gameInfo(page)).maxLevel, L + 1);
  assert.equal((await mergesOf(page)).length, 1);

  // c2: 3개가 한꺼번에 닿으면 2개만 합쳐지고 1개는 남는다
  await restartGame0(page);
  const r2 = FRUITS[2].radius;
  const y2 = WORLD.height - r2;
  await spawn(page, 2, 100, y2);
  await spawn(page, 2, 100 + 2 * r2 - 3, y2);
  await spawn(page, 2, 100 + 2 * (2 * r2 - 3), y2);
  await advance(page, 100);
  bs = await bodiesOf(page);
  assert.deepEqual(bs.map((b) => b.level).sort(), [2, 3], `3개 접촉 결과 ${JSON.stringify(bs.map((b) => b.level))}`);
  assert.equal(await scoreOfPage(page), scoreOf(3));
  assert.equal((await mergesOf(page)).length, 1);

  // c3: 연쇄 사다리 — 합쳐진 과일 옆에 같은 단계를 붙여 가며 0 → 8 까지
  await restartGame0(page);
  const top = 8;
  const r0 = FRUITS[0].radius;
  await spawn(page, 0, 150, WORLD.height - r0);
  await spawn(page, 0, 150 + 2 * r0 - 2, WORLD.height - r0);
  let expected = 0;
  for (let lvl = 1; lvl <= top; lvl++) {
    await advance(page, 250);
    bs = await bodiesOf(page);
    assert.equal(bs.length, 1, `lv${lvl} 합친 뒤 과일 수 ${bs.length}: ${JSON.stringify(bs.map((b) => b.level))}`);
    assert.equal(bs[0].level, lvl);
    expected += scoreOf(lvl);
    assert.equal(await scoreOfPage(page), expected, `lv${lvl} 누적 점수`);
    if (lvl === top) break;
    const r = FRUITS[lvl].radius;
    const side = bs[0].x > WORLD.width / 2 ? -1 : 1;
    await spawn(page, lvl, bs[0].x + side * (2 * r - 2), WORLD.height - r);
  }
  const merges = await mergesOf(page);
  assert.equal(merges.length, top);
  assert.deepEqual(merges.map((m) => m.level), Array.from({ length: top }, (_, i) => i + 1));

  // c4: 한 번에 여러 개 — 질량 보존 (2^level 합), 점수 = 이벤트 합, 남은 같은 단계 겹침 없음
  await restartGame0(page);
  const levels = [0, 0, 0, 0, 1, 1, 2];
  let x = 40;
  for (const lvl of levels) {
    const r = FRUITS[lvl].radius;
    await spawn(page, lvl, x + r, WORLD.height - r);
    x += 2 * r - 4;
  }
  const mass0 = massOf(await bodiesOf(page));
  await advance(page, 3000);
  bs = await bodiesOf(page);
  assert.equal(massOf(bs), mass0, '합치기 전후 질량(2^level 합)이 같아야 함');
  const ev = await mergesOf(page);
  assert.equal(await scoreOfPage(page), ev.reduce((s, m) => s + scoreOf(m.level), 0), '점수 = 합치기 이벤트 점수의 합');
  assert.equal(new Set(bs.map((b) => b.id)).size, bs.length);
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      if (bs[i].level !== bs[j].level) continue;
      const d = Math.hypot(bs[i].x - bs[j].x, bs[i].y - bs[j].y);
      assert.ok(d >= FRUITS[bs[i].level].radius * 2 - 0.5, `같은 단계 두 과일이 겹친 채 남음: ${JSON.stringify([bs[i], bs[j]])}`);
    }
  }
});

// 시나리오 안에서 판 상태를 비우고 새로 시작한다 (진행 중인 판에서 호출)
async function restartGame0(page) {
  await page.evaluate(() => {
    window.__fruit.physics.clear();
    window.__fruit.game.start(0);
    window.__merges = [];
  });
  assert.equal(await scoreOfPage(page), 0);
  assert.equal((await bodiesOf(page)).length, 0);
}

scenario('d', '수박: 첫 완성 배너 1회, 계속 진행, 수박 쌍 → 소멸+보너스', {}, async (env) => {
  const { page } = env;
  await loadGame(env);
  await startGame(page);
  await pause(page);
  // #clear-banner 가 '보이는 상태로 바뀐 횟수'를 센다
  await page.evaluate(() => {
    const el = document.getElementById('clear-banner');
    window.__bannerShown = el.hidden ? 0 : 1;
    new MutationObserver(() => { if (!el.hidden) window.__bannerShown += 1; }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  });
  const shown = () => page.evaluate(() => window.__bannerShown);

  // 멜론 쌍 → 수박 첫 완성
  const r9 = FRUITS[9].radius;
  await spawn(page, 9, WORLD.width / 2 - r9 + 10, WORLD.height - r9);
  await spawn(page, 9, WORLD.width / 2 + r9 - 10, WORLD.height - r9);
  await advance(page, 100);
  let bs = await bodiesOf(page);
  assert.equal(bs.length, 1);
  assert.equal(bs[0].level, LAST_LEVEL);
  assert.equal(await scoreOfPage(page), scoreOf(LAST_LEVEL));
  assert.equal(await shown(), 1, '배너가 1회 떠야 함');
  assert.ok(await isVisible(page, '#clear-banner'));
  assert.equal((await gameInfo(page)).cleared, true);
  assert.ok(['READY', 'COOLDOWN'].includes(await stateOf(page)), '수박을 만들어도 게임은 계속');
  // 배너는 자동으로 사라진다
  await page.waitForFunction(() => document.getElementById('clear-banner').hidden, null, { timeout: 5000 });

  // 두 번째 수박 생성: 배너는 다시 뜨지 않는다 (one-shot)
  const s1 = await scoreOfPage(page);
  const rr = FRUITS[LAST_LEVEL].radius;
  await page.evaluate(() => window.__fruit.physics.clear());
  await spawn(page, 9, 105, WORLD.height - r9);
  await spawn(page, 9, 295, WORLD.height - r9);
  await advance(page, 100);
  bs = await bodiesOf(page);
  assert.deepEqual(bs.map((b) => b.level), [LAST_LEVEL]);
  assert.equal(await scoreOfPage(page), s1 + scoreOf(LAST_LEVEL));
  assert.equal(await shown(), 1, '두 번째 수박에서는 배너가 다시 뜨면 안 됨');

  // 수박 쌍: 둘 다 사라지고 보너스만, 새 과일 없음
  const s2 = await scoreOfPage(page);
  await spawn(page, LAST_LEVEL, rr + 4, WORLD.height - rr);
  await advance(page, 100); // 위의 수박 + 새 수박 → 쌍
  bs = await bodiesOf(page);
  assert.equal(bs.length, 0, `수박 쌍 뒤 남은 과일 ${JSON.stringify(bs)}`);
  assert.equal(await scoreOfPage(page), s2 + WATERMELON_PAIR_BONUS);
  assert.equal(await shown(), 1);
  await advance(page, 500);
  assert.equal((await bodiesOf(page)).length, 0, '아무것도 새로 생기면 안 됨');
  assert.ok(['READY', 'COOLDOWN'].includes(await stateOf(page)));
});

scenario('e', '게임오버: 유예/체류 시간, 오버레이, 신기록, 최고점 저장', { storage: { [STORAGE_KEYS.best]: '5' } }, async (env) => {
  const { page } = env;
  await loadGame(env);
  assert.equal(await text(page, '#best'), '5');
  await startGame(page);
  await mouseDrop(page, 200); // 실제 드롭 1회 (drops=1)
  await pause(page);
  await advance(page, 4000); // 먼저 안착시킨다
  const r3 = FRUITS[3].radius;
  await page.evaluate(() => window.__fruit.physics.clear());
  await spawn(page, 3, 120, WORLD.height - r3);
  await spawn(page, 3, 120 + 2 * r3 - 2, WORLD.height - r3);
  await advance(page, 300);
  assert.equal(await scoreOfPage(page), scoreOf(4)); // 15
  assert.equal(await text(page, '#score'), String(scoreOf(4)));

  // 방금 만든 과일이 경계선 위에 있어도 유예 시간 동안은 게임오버가 아니다
  await pinAboveLine(page, 3, 300);
  await advance(page, TIMING.settleGrace - 100);
  let info = await gameInfo(page);
  assert.ok(['READY', 'COOLDOWN'].includes(info.state), '유예 시간 안에 게임오버가 됨');
  assert.equal(info.danger, 0);
  // 유예 종료 후 체류 시간이 지나기 전까지는 게임오버가 아니다 (위험도는 올라간다)
  await advance(page, 100 + TIMING.overflow * 0.6);
  info = await gameInfo(page);
  assert.ok(['READY', 'COOLDOWN'].includes(info.state));
  assert.ok(info.danger > 0.5 && info.danger < 1, `danger=${info.danger}`);
  // 중간에 내려가면 타이머가 리셋된다
  await page.evaluate(() => {
    const b = window.__fruit.physics.bodies().find((x) => x.isStatic);
    Matter.Body.setPosition(b, { x: 300, y: 350 });
  });
  await advance(page, 100);
  info = await gameInfo(page);
  assert.equal(info.danger, 0, '내려가면 위험도가 0 으로 돌아가야 함');
  await page.evaluate(() => {
    const b = window.__fruit.physics.bodies().find((x) => x.isStatic);
    Matter.Body.setPosition(b, { x: 300, y: 40 });
  });
  await advance(page, TIMING.overflow * 0.9);
  assert.ok(['READY', 'COOLDOWN'].includes((await gameInfo(page)).state), '타이머가 리셋되지 않음');
  await advance(page, TIMING.overflow * 0.2 + 50);
  assert.equal(await stateOf(page), 'GAME_OVER');

  assert.ok(await isVisible(page, '#screen-gameover'));
  assert.equal(await text(page, '#final-score'), '15');
  assert.ok(await isVisible(page, '#new-record'), '신기록 배지');
  assert.equal(await text(page, '#final-best'), '15');
  assert.equal(await lsGet(page, STORAGE_KEYS.best), '15');
  assert.equal(await text(page, '#best'), '15');
  assert.ok(!(await isVisible(page, '#submit-form')), '오프라인이면 제출 폼 숨김');
  const frozen = await bodiesOf(page);
  await advance(page, 1000);
  assert.deepEqual(await bodiesOf(page), frozen, '게임오버 뒤 물리가 멈춰야 함');

  // 두 번째 판: 점수가 최고점보다 낮으면 신기록 아님, 저장값 유지
  await restartGame(page);
  await pause(page);
  assert.equal(await text(page, '#score'), '0');
  const r0 = FRUITS[0].radius;
  await spawn(page, 0, 100, WORLD.height - r0);
  await spawn(page, 0, 100 + 2 * r0 - 2, WORLD.height - r0);
  await advance(page, 200);
  await page.evaluate(() => window.__fruit.forceGameOver());
  assert.equal(await text(page, '#final-score'), '3');
  assert.ok(!(await isVisible(page, '#new-record')), '낮은 점수는 신기록이 아님');
  assert.equal(await text(page, '#final-best'), '15');
  assert.equal(await lsGet(page, STORAGE_KEYS.best), '15');

  // 점수 0 판도 신기록이 아니다
  await restartGame(page);
  await page.evaluate(() => window.__fruit.forceGameOver());
  assert.equal(await text(page, '#final-score'), '0');
  assert.ok(!(await isVisible(page, '#new-record')));
});

scenario('e2', '게임오버: 실제로 쌓아서 넘치면 끝난다 (상자 이탈 없음)', {}, async (env) => {
  const { page } = env;
  await loadGame(env);
  await startGame(page);
  await pause(page);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let over = false;
  let spawned = 0;
  for (; spawned < 160 && !over; spawned++) {
    const level = 2 + Math.floor(rnd() * 4);
    const r = FRUITS[level].radius;
    await spawn(page, level, r + rnd() * (WORLD.width - 2 * r), WORLD.spawnY);
    await advance(page, 400);
    for (const b of await bodiesOf(page)) assert.ok(inBox(b, 6), `상자를 벗어남: ${JSON.stringify(b)}`);
    over = (await stateOf(page)) === 'GAME_OVER';
  }
  // 마지막 과일이 놓인 직후엔 위험하지 않으므로, 쌓인 채 시간을 더 흘려보낸다
  for (let i = 0; i < 40 && !over; i++) {
    await advance(page, 250);
    over = (await stateOf(page)) === 'GAME_OVER';
  }
  assert.ok(over, `${spawned}개를 쌓았는데도 게임오버가 되지 않음`);
  assert.ok(await isVisible(page, '#screen-gameover'));
  assert.equal(await text(page, '#final-score'), String(await scoreOfPage(page)));
});

scenario('f', '재시작: 바디/점수/배너 초기화, 다시 플레이 가능', {}, async (env) => {
  const { page } = env;
  await loadGame(env);
  await startGame(page);
  await mouseDrop(page, 150);
  await pause(page);
  const r9 = FRUITS[9].radius;
  await spawn(page, 9, 105, WORLD.height - r9);
  await spawn(page, 9, 295, WORLD.height - r9);
  await advance(page, 200);
  assert.ok(await isVisible(page, '#clear-banner'), '배너가 떠 있는 상태에서 끝낸다');
  assert.ok((await bodiesOf(page)).length >= 1);
  await page.evaluate(() => window.__fruit.forceGameOver());
  assert.ok(await isVisible(page, '#screen-gameover'));
  assert.ok(!(await isVisible(page, '#clear-banner')), '게임오버 때 배너는 사라져야 함');

  await restartGame(page);
  assert.equal((await bodiesOf(page)).length, 0, '이전 판의 바디가 남음');
  const info = await gameInfo(page);
  assert.equal(info.score, 0);
  assert.equal(info.drops, 0);
  assert.equal(info.maxLevel, 0);
  assert.equal(info.cleared, false);
  assert.equal(await text(page, '#score'), '0');
  assert.ok(!(await isVisible(page, '#clear-banner')));
  assert.ok(!(await isVisible(page, '#screen-gameover')));
  assert.equal(await page.locator('#ranking-list > li').count(), 0);
  // 재시작 클릭이 드롭으로 이어지지 않았고, 이후 정상 플레이
  assert.equal((await bodiesOf(page)).length, 0);
  await mouseDrop(page, 250);
  assert.equal((await bodiesOf(page)).length, 1);
  await settleChecked(page, 4000);
  assert.equal((await bodiesOf(page)).length, 1);
  // 옛 판의 수박 쌍이 새 판에서 다시 배너를 띄운다 (cleared 도 초기화됨)
  await page.evaluate(() => window.__fruit.physics.clear());
  await spawn(page, 9, 105, WORLD.height - r9);
  await spawn(page, 9, 295, WORLD.height - r9);
  await advance(page, 200);
  assert.ok(await isVisible(page, '#clear-banner'));
});

scenario('g', '오프라인(API_URL 없음): 제출 폼 숨김, 안내 문구, 외부 호출 없음', {}, async (env) => {
  const { page } = env;
  await loadGame(env);
  // 하네스가 API_URL 을 항상 ''로 고정하므로, 운영 URL 이 config.js 에 들어 있어도 이 시나리오는 오프라인이다
  assert.equal(await page.evaluate(() => import('./js/config.js').then((m) => m.API_URL)), '');
  // 시작 화면의 랭킹 보기
  await page.click('#btn-view-ranking');
  assert.ok(await isVisible(page, '#screen-ranking'));
  assert.match(await text(page, '#ranking-view-status'), /오프라인|연결되지/);
  assert.equal(await page.locator('#ranking-view-list > li').count(), 0);
  await page.click('#btn-close-ranking');
  assert.ok(await isVisible(page, '#screen-start'));

  await startGame(page);
  await pause(page);
  await page.evaluate(() => window.__fruit.forceGameOver());
  assert.ok(await isVisible(page, '#screen-gameover'));
  assert.ok(!(await isVisible(page, '#submit-form')), '제출 폼이 숨겨져야 함');
  assert.match(await text(page, '#ranking-status'), /오프라인|연결되지/);
  assert.equal(await lsGet(page, STORAGE_KEYS.pending), null);

  const external = env.requests.filter((r) => {
    const u = new URL(r.url);
    return !u.protocol.startsWith('data') && u.origin !== env.server.origin && r.url !== CDN_MATTER;
  });
  assert.deepEqual(external.map((r) => r.url), [], '외부 호출이 있으면 안 됨');
  assert.ok(!env.requests.some((r) => /google/.test(r.url)));
});

scenario('h', 'API 모드: 랭킹 렌더(textContent), 제출(text/plain), 성공/실패/재시도', {
  fakeApi: () => createFakeApi({ rows: sampleRows(5), postQueue: ['server_busy', 'abort', 'ok'] }),
  ignore: [/net::ERR_FAILED/],
}, async (env) => {
  const { page } = env;
  const api = env.fakeApi;
  await loadGame(env);

  // 시작 화면에서 랭킹 보기: XSS 닉네임은 글자 그대로 보인다
  await page.click('#btn-view-ranking');
  await page.waitForFunction(() => document.querySelectorAll('#ranking-view-list > li').length === 5);
  assert.equal(await page.locator('#ranking-view-list img').count(), 0, 'img 태그가 만들어지면 안 됨');
  const names = await page.locator('#ranking-view-list > li > :nth-child(2)').allInnerTexts();
  assert.ok(names.includes(XSS_NICK), `XSS 닉네임이 글자 그대로 보여야 함: ${JSON.stringify(names)}`);
  assert.deepEqual(env.dialogs, []);
  const first = await page.locator('#ranking-view-list > li:first-child').innerText();
  assert.match(first, /플레이어1/);
  assert.match(first, /5,000/);
  assert.equal(api.gets.length, 1);
  assert.equal(api.gets[0].searchParams.get('action'), 'ranking');
  assert.equal(api.gets[0].searchParams.get('limit'), '10');
  await page.keyboard.press('Escape');
  assert.ok(!(await isVisible(page, '#screen-ranking')));

  // 한 판: 실제 드롭 1회 + 합치기 점수
  await startGame(page);
  await mouseDrop(page, 200);
  await pause(page);
  await advance(page, 3000);
  await page.evaluate(() => window.__fruit.physics.clear());
  const r2 = FRUITS[2].radius;
  await spawn(page, 2, 120, WORLD.height - r2);
  await spawn(page, 2, 120 + 2 * r2 - 2, WORLD.height - r2);
  await advance(page, 300);
  const score = await scoreOfPage(page);
  await page.evaluate(() => window.__fruit.forceGameOver());
  assert.ok(await isVisible(page, '#screen-gameover'));
  assert.ok(await isVisible(page, '#submit-form'));
  await page.waitForFunction(() => document.querySelectorAll('#ranking-list > li').length === 5);
  assert.equal(await page.locator('#ranking-list img').count(), 0);

  // 닉네임이 비면 서버로 보내지 않는다
  await page.fill('#input-nickname', '   ');
  await page.click('#btn-submit');
  assert.equal(api.posts.length, 0);
  assert.match(await text(page, '#submit-status'), /닉네임/);

  // 1) 서버 바쁨 → 버튼 다시 열림 + 재시도 보관
  await page.fill('#input-nickname', '테스터');
  await page.click('#btn-submit');
  await page.waitForFunction(() => /바빠요/.test(document.getElementById('submit-status').textContent));
  assert.ok(await page.locator('#btn-submit').isEnabled(), 'server_busy 뒤 버튼이 다시 열려야 함');
  assert.equal(await text(page, '#btn-submit'), '다시 시도');
  let pending = JSON.parse(await lsGet(page, STORAGE_KEYS.pending));
  assert.equal(pending.score, score);
  assert.equal(pending.nickname, '테스터');

  // POST 규약: text/plain, 커스텀 헤더 없음, 본문 JSON 에 모든 필드
  const post = api.posts[0];
  assert.match(post.headers['content-type'], /^text\/plain;\s*charset=utf-8$/i);
  assert.ok(!Object.keys(post.headers).some((k) => /^(authorization|x-)/i.test(k)), `커스텀 헤더: ${Object.keys(post.headers)}`);
  assert.equal(api.preflight ?? 0, 0, 'preflight(OPTIONS)가 발생하면 안 됨');
  assert.ok(post.body, '본문이 JSON 이어야 함');
  assert.deepEqual(Object.keys(post.body).sort(), ['clientId', 'drops', 'maxLevel', 'nickname', 'playTimeMs', 'score']);
  assert.equal(post.body.nickname, '테스터');
  assert.equal(post.body.score, score);
  assert.equal(post.body.drops, 1);
  assert.ok(Number.isInteger(post.body.maxLevel) && post.body.maxLevel >= 0 && post.body.maxLevel <= LAST_LEVEL);
  assert.ok(Number.isFinite(post.body.playTimeMs) && post.body.playTimeMs >= 1);
  assert.match(post.body.clientId, CLIENT_ID_RE);
  assert.equal(post.body.clientId, await lsGet(page, STORAGE_KEYS.clientId));
  // 서버의 개연성 규칙(드롭 사이 최소 400ms)을 클라이언트가 만족한다
  assert.ok(post.body.playTimeMs >= (post.body.drops - 1) * 400);

  // 2) 네트워크 실패 → 다시 열림
  await page.click('#btn-submit');
  await page.waitForFunction(() => /네트워크/.test(document.getElementById('submit-status').textContent));
  assert.ok(await page.locator('#btn-submit').isEnabled(), '네트워크 실패 뒤 버튼이 다시 열려야 함');
  pending = JSON.parse(await lsGet(page, STORAGE_KEYS.pending));
  assert.equal(pending.score, score);

  // 3) 성공 → 버튼 비활성, 보관분 삭제, 랭킹 갱신, 중복 제출 불가
  await page.click('#btn-submit');
  await page.waitForFunction(() => document.getElementById('btn-submit').textContent === '등록 완료');
  assert.ok(await page.locator('#btn-submit').isDisabled());
  assert.equal(await lsGet(page, STORAGE_KEYS.pending), null);
  assert.equal(api.posts.length, 3);
  await page.waitForFunction(() => document.querySelectorAll('#ranking-list > li').length === 6 && /테스터/.test(document.getElementById('ranking-list').textContent));
  await page.locator('#input-nickname').evaluate((el) => el.form.requestSubmit());
  await page.waitForTimeout(150);
  assert.equal(api.posts.length, 3, '성공 뒤 중복 제출됨');
  assert.equal(await lsGet(page, STORAGE_KEYS.nickname), '테스터');

  // 재시작하면 제출 상태가 초기화된다
  await restartGame(page);
  await page.evaluate(() => window.__fruit.forceGameOver());
  assert.ok(await page.locator('#btn-submit').isEnabled());
  assert.equal(await text(page, '#btn-submit'), '랭킹 등록');
  assert.equal(await page.inputValue('#input-nickname'), '테스터');
});

scenario('h2', 'API 모드: 부팅 때 보관된 점수를 조용히 재전송, 서버 HTML 응답은 실패 처리', {
  fakeApi: () => createFakeApi({ rows: [], postQueue: ['ok'] }),
  storage: {
    [STORAGE_KEYS.pending]: JSON.stringify({ nickname: '보관', score: 77, maxLevel: 3, playTimeMs: 20000, drops: 12, clientId: 'abcdefghijklmnop1234' }),
  },
}, async (env) => {
  const { page } = env;
  const api = env.fakeApi;
  await loadGame(env);
  await page.waitForFunction(() => localStorage.getItem('fruit.pendingScore') === null);
  assert.equal(api.posts.length, 1);
  assert.equal(api.posts[0].body.nickname, '보관');
  assert.equal(api.posts[0].body.score, 77);
  assert.match(api.posts[0].headers['content-type'], /^text\/plain/);
  // 재전송된 기록이 랭킹에 나타난다
  await page.click('#btn-view-ranking');
  await page.waitForFunction(() => /보관/.test(document.getElementById('ranking-view-list').textContent));
  await page.keyboard.press('Escape');
  // HTML(로그인 페이지 등) 응답 → bad_response 로 취급되어 재시도 가능
  api.postQueue.push('html');
  await startGame(page);
  await mouseDrop(page, 200);
  await pause(page);
  await advance(page, 1000);
  await page.evaluate(() => window.__fruit.forceGameOver());
  await page.fill('#input-nickname', 'html');
  await page.click('#btn-submit');
  await page.waitForFunction(() => /이해하지 못했어요/.test(document.getElementById('submit-status').textContent));
  assert.ok(await page.locator('#btn-submit').isEnabled());
});

scenario('h3', 'API 모드: 빈 랭킹 안내, 서버 오류 시 랭킹 실패 문구(게임은 계속)', {
  fakeApi: () => createFakeApi({ rows: [] }),
}, async (env) => {
  const { page } = env;
  await loadGame(env);
  await page.click('#btn-view-ranking');
  await page.waitForFunction(() => /첫 기록/.test(document.getElementById('ranking-view-status').textContent));
  assert.equal(await page.locator('#ranking-view-list > li').count(), 0);
  await page.keyboard.press('Escape');
  // 랭킹 호출이 HTML(오류 페이지)로 돌아와도 게임은 정상
  await env.ctx.route(FAKE_API_RE, (route) => route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: 'oops' }));
  env.ignore.push(/status of 500/, /^500 /);
  await page.click('#btn-view-ranking');
  await page.waitForFunction(() => /불러오지 못했어요/.test(document.getElementById('ranking-view-status').textContent));
  await page.keyboard.press('Escape');
  await startGame(page);
  await mouseDrop(page, 200);
  assert.equal((await bodiesOf(page)).length, 1);
});

scenario('h4', 'API 모드: 부팅 때 재전송이 재시도 가능한 오류로 실패하면 보관분을 지키고, 영구 오류면 지운다', {
  fakeApi: () => createFakeApi({ rows: [], postQueue: ['server_busy'] }),
  storage: {
    [STORAGE_KEYS.pending]: JSON.stringify({ nickname: '보관', score: 77, maxLevel: 3, playTimeMs: 20000, drops: 12, clientId: 'abcdefghijklmnop1234' }),
  },
}, async (env) => {
  const { page } = env;
  const api = env.fakeApi;
  const kept = async () => JSON.parse((await lsGet(page, STORAGE_KEYS.pending)) ?? 'null');
  await loadGame(env);
  await until(() => api.posts.length === 1, '첫 재전송');
  await page.waitForTimeout(250); // 응답 처리 시간
  assert.equal((await kept())?.score, 77, 'server_busy 로 실패했는데 보관분이 사라짐');

  // 다음 접속: 이번에는 서버가 영구 오류로 거절한다 -> 더 보내 봐야 소용없으니 지운다
  api.postQueue.push('invalid_nickname');
  await page.reload();
  await until(() => api.posts.length === 2, '두 번째 재전송');
  await page.waitForFunction(() => localStorage.getItem('fruit.pendingScore') === null);
  assert.equal(api.posts[1].body.score, 77);

  // throttled 는 시간이 지나면 풀리는 오류라 보관분을 지킨다
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [STORAGE_KEYS.pending, JSON.stringify({ nickname: '보관', score: 78, maxLevel: 3, playTimeMs: 20000, drops: 12, clientId: 'abcdefghijklmnop1234' })]);
  api.postQueue.push('throttled');
  await page.reload();
  await until(() => api.posts.length === 3, '세 번째 재전송');
  await page.waitForTimeout(250);
  assert.equal((await kept())?.score, 78, 'throttled 인데 보관분이 사라짐');
});

scenario('h5', 'API 모드: 늦게 도착한 이전 응답은 화면을 건드리지 않는다 (랭킹 닫기/다음 판 시작 뒤)', {
  fakeApi: () => createFakeApi({ rows: sampleRows(3, false) }),
}, async (env) => {
  const { page } = env;
  const api = env.fakeApi;
  await loadGame(env);

  // 1) 랭킹을 열었다가 응답이 오기 전에 닫는다: 늦게 온 응답이 닫힌 목록에 그려지면 안 된다
  api.getDelayMs = 600;
  await page.click('#btn-view-ranking');
  await until(() => api.gets.length === 1, '랭킹 요청');
  await page.keyboard.press('Escape');
  assert.ok(await isVisible(page, '#screen-start'));
  await page.waitForTimeout(900);
  assert.equal(await page.locator('#ranking-view-list > li').count(), 0, '닫은 뒤 도착한 응답이 목록에 그려짐');
  api.getDelayMs = 0;
  await page.click('#btn-view-ranking');
  await page.waitForFunction(() => document.querySelectorAll('#ranking-view-list > li').length === 3);
  await page.keyboard.press('Escape');

  // 2) 제출 응답이 오기 전에 다음 판을 시작한다: 새 판의 결과 화면 상태(버튼/입력/문구)가 오염되면 안 된다
  await startGame(page);
  await mouseDrop(page, 200);
  await pause(page);
  await advance(page, 1000);
  await page.evaluate(() => window.__fruit.forceGameOver());
  await page.fill('#input-nickname', '느린응답');
  api.postDelayMs = 600;
  await page.click('#btn-submit');
  await until(() => api.posts.length === 1, '제출 요청');
  await restartGame(page);
  await page.waitForTimeout(900); // 이전 판의 제출 응답(ok)이 이제 도착한다
  const panel = await page.evaluate(() => ({
    label: document.getElementById('btn-submit').textContent,
    disabled: document.getElementById('input-nickname').disabled,
    status: document.getElementById('submit-status').textContent,
    rows: document.querySelectorAll('#ranking-list > li').length,
  }));
  assert.deepEqual(panel, { label: '랭킹 등록', disabled: false, status: '', rows: 0 }, '이전 판의 응답이 새 판의 결과 화면 상태를 바꿈');
  assert.equal(await lsGet(page, STORAGE_KEYS.pending), null, '성공했으니 보관분은 없다');
});

const VIEWPORTS = [
  { id: 'mobile 390x844', viewport: { width: 390, height: 844 }, mobile: true },
  { id: 'mobile 320x568', viewport: { width: 320, height: 568 }, mobile: true },
  { id: 'desktop 1280x720', viewport: { width: 1280, height: 720 }, mobile: false },
];

for (const [i, v] of VIEWPORTS.entries()) {
  scenario(`i${i + 1}`, `반응형 ${v.id}: 터치/클릭 드롭, 스크롤 없음, 캔버스·HUD·진화 줄이 모두 보임`, {
    viewport: v.viewport,
    mobile: v.mobile,
    fakeApi: () => createFakeApi({ rows: sampleRows(10) }),
  }, async (env) => {
    const { page } = env;
    await loadGame(env);
    assertLayout(await layoutMetrics(page), `${v.id} 시작 화면`);
    // 시작 화면 패널이 게임판 안에 들어온다
    const fits = async (sel) => page.evaluate((s) => {
      const p = document.querySelector(s).getBoundingClientRect();
      const st = document.getElementById('stage').getBoundingClientRect();
      return p.left >= st.left - 0.5 && p.right <= st.right + 0.5 && p.top >= st.top - 0.5 && p.bottom <= st.bottom + 0.5;
    }, sel);
    assert.ok(await fits('#screen-start .panel'), '시작 패널이 게임판 밖으로 나감');

    if (v.mobile) await page.tap('#btn-start');
    else await page.click('#btn-start');
    await page.waitForFunction(() => window.__fruit.getState() === 'READY');
    assert.equal((await bodiesOf(page)).length, 0, '시작 탭이 드롭이 되면 안 됨');
    assertLayout(await layoutMetrics(page), `${v.id} 플레이 중`);

    const p = await worldToClient(page, 90, 250);
    if (v.mobile) await page.touchscreen.tap(p.x, p.y);
    else await page.mouse.click(p.x, p.y);
    const bs = await bodiesOf(page);
    assert.equal(bs.length, 1, '탭/클릭으로 드롭되어야 함');
    assert.ok(Math.abs(bs[0].x - 90) < 3, `드롭 x=${bs[0].x}`);
    await pause(page);
    await settleChecked(page, 3000);

    // 스크롤/휠 시도에도 페이지가 움직이지 않는다
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(50);
    assertLayout(await layoutMetrics(page), `${v.id} 스크롤 시도 후`);

    // 게임오버 패널(랭킹 10줄): 패널은 게임판 안, 다시 하기 버튼은 보인다
    await page.evaluate(() => window.__fruit.forceGameOver());
    await page.waitForFunction(() => document.querySelectorAll('#ranking-list > li').length === 10);
    assert.ok(await fits('#screen-gameover .panel'), '게임오버 패널이 게임판 밖으로 나감');
    assert.ok(await fits('#btn-restart'), '다시 하기 버튼이 보이지 않음');
    assert.ok(await fits('#btn-submit'), '랭킹 등록 버튼이 보이지 않음');
    assertLayout(await layoutMetrics(page), `${v.id} 게임오버`);
    if (v.mobile) await page.tap('#btn-restart');
    else await page.click('#btn-restart');
    await page.waitForFunction(() => window.__fruit.getState() === 'READY');
    assert.equal((await bodiesOf(page)).length, 0);
  });
}

// 가로로 눕힌 폰과 200~300% 확대한 데스크톱: 게임판이 쪼그라들거나 버튼/입력이 잘리면 안 된다
const LANDSCAPE_VIEWPORTS = [
  { id: 'landscape 667x375', viewport: { width: 667, height: 375 }, mobile: true },
  { id: 'landscape 568x320', viewport: { width: 568, height: 320 }, mobile: true },
  { id: 'landscape 844x390', viewport: { width: 844, height: 390 }, mobile: true },
  { id: 'zoom 300% 427x240', viewport: { width: 427, height: 240 }, mobile: false },
];

// 화면 안에 완전히 들어오고, 그 자리에서 실제로 눌리는지 (다른 요소가 덮고 있지 않은지)
const reachable = (page, sel) => page.evaluate((q) => {
  const el = document.querySelector(q);
  const b = el.getBoundingClientRect();
  if (b.left < 0 || b.top < 0 || b.right > innerWidth || b.bottom > innerHeight) return false;
  const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
  return !!hit && (hit === el || el.contains(hit));
}, sel);

for (const [i, v] of LANDSCAPE_VIEWPORTS.entries()) {
  scenario(`n${i + 1}`, `가로 모드 ${v.id}: 게임판은 높이를 다 쓰고, 시작 버튼/닉네임 입력/등록 버튼이 쓸 만하다`, {
    viewport: v.viewport,
    mobile: v.mobile,
    fakeApi: () => createFakeApi({ rows: sampleRows(10) }),
  }, async (env) => {
    const { page } = env;
    const api = env.fakeApi;
    const tap = (sel) => (v.mobile ? page.tap(sel) : page.click(sel));
    await loadGame(env);

    let m = await layoutMetrics(page);
    assertLayout(m, `${v.id} 시작 화면`, { minCanvasW: 120, sideBySide: true });
    assert.ok(m.stage.h >= m.vh - 20, `${v.id}: 게임판이 높이를 다 쓰지 못함 (${m.stage.h}/${m.vh})`);
    assert.ok(await reachable(page, '#btn-start'), `${v.id}: 게임 시작 버튼이 첫 화면에서 안 보이거나 가려짐`);
    assert.ok(await reachable(page, '#btn-view-ranking'), `${v.id}: 랭킹 보기 버튼이 안 보임`);

    await tap('#btn-start');
    await page.waitForFunction(() => window.__fruit.getState() === 'READY');
    assertLayout(await layoutMetrics(page), `${v.id} 플레이 중`, { minCanvasW: 120, sideBySide: true });
    const p = await worldToClient(page, 90, 250);
    if (v.mobile) await page.touchscreen.tap(p.x, p.y);
    else await page.mouse.click(p.x, p.y);
    const bs = await bodiesOf(page);
    assert.equal(bs.length, 1, '탭/클릭으로 드롭되어야 함');
    assert.ok(Math.abs(bs[0].x - 90) < 3, `드롭 x=${bs[0].x}`);
    await pause(page);

    // 게임오버: 닉네임 입력이 글자를 보여 줄 만큼 넓고, 등록 버튼이 패널 밖으로 잘리지 않는다
    await page.evaluate(() => window.__fruit.forceGameOver());
    await page.waitForFunction(() => document.querySelectorAll('#ranking-list > li').length === 10);
    assert.ok(await reachable(page, '#btn-restart'), `${v.id}: 다시 하기 버튼이 안 보임`);
    const form = await page.evaluate(() => {
      const panel = document.querySelector('#screen-gameover .panel').getBoundingClientRect();
      const input = document.getElementById('input-nickname');
      const cs = getComputedStyle(input);
      const ib = input.getBoundingClientRect();
      const sb = document.getElementById('btn-submit').getBoundingClientRect();
      return {
        panel: { l: panel.left, r: panel.right, t: panel.top, b: panel.bottom },
        content: input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        input: { l: ib.left, r: ib.right },
        submit: { l: sb.left, r: sb.right },
      };
    });
    assert.ok(form.content >= 80, `${v.id}: 닉네임 입력의 글자 영역이 ${form.content}px 뿐`);
    for (const [name, r] of [['입력창', form.input], ['등록 버튼', form.submit]]) {
      assert.ok(r.l >= form.panel.l - 0.5 && r.r <= form.panel.r + 0.5, `${v.id}: ${name}이 패널 밖으로 잘림 ${JSON.stringify(r)} / ${JSON.stringify(form.panel)}`);
    }
    assert.ok(form.panel.t >= 0 && form.panel.b <= m.vh + 0.5 && form.panel.r <= m.vw + 0.5, `${v.id}: 게임오버 패널이 화면 밖으로 나감`);

    // 실제로 입력하고 등록할 수 있다 (가려져 있으면 Playwright 의 클릭이 실패한다)
    await page.locator('#input-nickname').scrollIntoViewIfNeeded();
    await page.locator('#input-nickname').click();
    await page.keyboard.type('가로모드');
    assert.equal(await page.inputValue('#input-nickname'), '가로모드');
    await page.locator('#btn-submit').scrollIntoViewIfNeeded();
    await tap('#btn-submit');
    await page.waitForFunction(() => document.getElementById('btn-submit').textContent === '등록 완료');
    assert.equal(api.posts.length, 1);
    assert.equal(api.posts[0].body.nickname, '가로모드');

    await tap('#btn-restart');
    await page.waitForFunction(() => window.__fruit.getState() === 'READY');
    assert.equal((await bodiesOf(page)).length, 0);
  });
}

scenario('j', '키보드: ←/→ 이동, Space 드롭, 닉네임 입력은 게임을 건드리지 않음', {
  fakeApi: () => createFakeApi({ rows: sampleRows(3, false) }),
}, async (env) => {
  const { page } = env;
  await loadGame(env);
  await startGame(page);
  await pause(page);

  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(450);
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.press('Space');
  let bs = await bodiesOf(page);
  assert.equal(bs.length, 1);
  assert.ok(bs[0].x < WORLD.width / 2 - 40, `왼쪽으로 이동하지 않음 x=${bs[0].x}`);
  const leftX = bs[0].x;

  await advance(page, TIMING.dropCooldown);
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(900);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.press('Space');
  bs = (await bodiesOf(page)).sort((a, b) => a.id - b.id);
  assert.equal(bs.length, 2);
  assert.ok(bs[1].x > leftX + 100, `오른쪽으로 이동하지 않음 x=${bs[1].x}`);

  // 누르고 있어도(repeat) 한 번만 드롭. 반복 입력 사이에 쿨다운이 지나가게 해서, 쿨다운이 아니라 repeat 검사가 막는지 본다.
  await advance(page, TIMING.dropCooldown);
  await page.keyboard.down('Space');
  await advance(page, TIMING.dropCooldown);
  assert.equal(await stateOf(page), 'READY');
  await page.keyboard.down('Space'); // repeat
  await advance(page, TIMING.dropCooldown);
  await page.keyboard.down('Space'); // repeat
  await page.keyboard.up('Space');
  assert.equal((await bodiesOf(page)).length, 3, '누르고 있는 Space 의 자동 반복이 드롭이 됨');

  // 게임오버 뒤 닉네임 입력: 이동/드롭/재시작 없음
  await page.evaluate(() => window.__fruit.forceGameOver());
  const before = await gameInfo(page);
  const nBodies = (await bodiesOf(page)).length;
  await page.click('#input-nickname');
  await page.fill('#input-nickname', '');
  await page.keyboard.type('a b  ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  assert.equal(await page.inputValue('#input-nickname'), 'a b  ArrowLeft'.slice(0, 12));
  assert.equal(await stateOf(page), 'GAME_OVER');
  assert.equal((await gameInfo(page)).drops, before.drops);
  assert.equal((await bodiesOf(page)).length, nBodies);
  assert.ok(await isVisible(page, '#screen-gameover'));

  // 포커스가 닉네임이 아닌 곳에 있어도 오버레이가 떠 있으면 Space 는 드롭하지 않는다
  await page.locator('#input-nickname').blur();
  await page.keyboard.press('Space');
  assert.equal((await gameInfo(page)).drops, before.drops);
});

scenario('k', '음소거 버튼: aria-pressed 토글, 저장, 새로고침 후 유지, Space 와 충돌 없음', {}, async (env) => {
  const { page } = env;
  await loadGame(env);
  const mute = page.locator('#btn-mute');
  assert.equal(await mute.getAttribute('aria-pressed'), 'false');
  assert.equal(await mute.getAttribute('aria-label'), '음소거');
  await mute.click();
  assert.equal(await mute.getAttribute('aria-pressed'), 'true');
  assert.equal(await lsGet(page, STORAGE_KEYS.muted), '1');
  // 토글 버튼은 이름이 상태에 따라 바뀌면 안 된다 ("소리 켜기, 눌림" 같은 모순된 낭독 방지)
  assert.equal(await mute.getAttribute('aria-label'), '음소거');
  await page.reload();
  await page.waitForFunction(() => !!window.__fruit);
  assert.equal(await page.locator('#btn-mute').getAttribute('aria-pressed'), 'true', '새로고침 뒤에도 유지');

  // 마우스로 누른 음소거 버튼이 포커스를 가져가 Space 가 토글을 다시 누르면 안 된다
  await startGame(page);
  await pause(page);
  await page.locator('#btn-mute').click();
  assert.equal(await page.locator('#btn-mute').getAttribute('aria-pressed'), 'false');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#btn-mute').getAttribute('aria-pressed'), 'false', 'Space 가 음소거를 다시 눌렀다');
  assert.equal((await bodiesOf(page)).length, 1, 'Space 가 드롭이 되어야 함');
  assert.notEqual(await lsGet(page, STORAGE_KEYS.muted), '1');
});

scenario('k2', '오디오 연결: 제스처 전에는 컨텍스트 없음, 클릭/드롭/합치기에서 소리, 음소거면 무음', {}, async (env) => {
  const { page } = env;
  await page.addInitScript(() => {
    const counts = { contexts: 0, osc: 0 };
    window.__audio = counts;
    for (const name of ['AudioContext', 'webkitAudioContext']) {
      const Base = window[name];
      if (!Base) continue;
      window[name] = class extends Base {
        constructor(...a) {
          super(...a);
          counts.contexts += 1;
        }
        createOscillator(...a) {
          counts.osc += 1;
          return super.createOscillator(...a);
        }
      };
    }
  });
  await loadGame(env);
  const audio = () => page.evaluate(() => ({ ...window.__audio }));
  assert.deepEqual(await audio(), { contexts: 0, osc: 0 }, '제스처 전에 오디오 컨텍스트가 만들어짐');

  await page.click('#btn-start'); // 시작 클릭: unlock + click 소리
  await page.waitForFunction(() => window.__fruit.getState() === 'READY');
  await page.waitForFunction(() => window.__audio.osc > 0, null, { timeout: 3000 });
  let a = await audio();
  assert.equal(a.contexts, 1, '컨텍스트는 한 번만 만들어져야 함');

  await pause(page);
  await advance(page, 700);
  let before = (await audio()).osc;
  await mouseDrop(page, 200);
  assert.ok((await audio()).osc > before, '드롭 소리가 나야 함');

  await advance(page, 700);
  before = (await audio()).osc;
  const r = FRUITS[2].radius;
  await spawn(page, 2, 100, WORLD.height - r);
  await spawn(page, 2, 100 + 2 * r - 2, WORLD.height - r);
  await advance(page, 100);
  assert.ok((await audio()).osc > before, '합치기 소리가 나야 함');

  // 음소거: 이후 어떤 동작도 소리를 새로 만들지 않는다
  await page.locator('#btn-mute').click();
  await page.waitForTimeout(100);
  before = (await audio()).osc;
  await advance(page, 700);
  await mouseDrop(page, 300);
  await spawn(page, 2, 100, WORLD.height - r);
  await spawn(page, 2, 100 + 2 * r - 2, WORLD.height - r);
  await advance(page, 100);
  assert.equal((await audio()).osc, before, '음소거인데 소리가 만들어짐');

  // 해제하면 다시 난다
  await page.locator('#btn-mute').click();
  await page.waitForTimeout(100);
  before = (await audio()).osc;
  await advance(page, 700);
  await mouseDrop(page, 120);
  assert.ok((await audio()).osc > before, '음소거 해제 뒤에도 소리가 안 남');
});

scenario('l', '프레임 정체: 메인 스레드가 오래 멈춰도 시뮬레이션이 폭주하지 않는다', {}, async (env) => {
  const { page } = env;
  await loadGame(env);
  await startGame(page);
  await mouseDrop(page, 200);
  await page.waitForTimeout(200);
  const simNow = () => page.evaluate(() => window.__fruit.advance(0));
  const t0 = await simNow();
  const stalled = await page.evaluate(() => new Promise((resolve) => {
    const start = performance.now();
    while (performance.now() - start < 1500) { /* 메인 스레드 정체 */ }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.__fruit.advance(0))));
  }));
  // 정체 1500ms 동안 흐른 시뮬레이션은 한 프레임 상한(100ms) + 소량이어야 한다
  assert.ok(stalled - t0 < 400, `정체 직후 sim 이 ${stalled - t0}ms 진행됨 (1500ms 정체)`);
  assert.ok(stalled - t0 >= 0);
  // 정상 상태에서는 실시간과 같은 속도(±)로 진행한다
  const a = await simNow();
  await page.waitForTimeout(1000);
  const b = await simNow();
  assert.ok(b - a > 600 && b - a < 1400, `1초 동안 sim ${b - a}ms`);
  for (const bd of await bodiesOf(page)) assert.ok(inBox(bd));
});

// 경계선 바로 위(붉은 빛이 번지는 자리)의 초록 채널을 일정 간격으로 읽는다. 경고가 깜빡이면 값이 흔들린다.
function sampleDangerGlow(page, durationMs = 700, everyMs = 35) {
  return page.evaluate(([total, step, wy, wx]) => new Promise((resolve) => {
    const canvas = document.getElementById('game-canvas');
    const g = canvas.getContext('2d');
    const k = canvas.width / 400;
    const out = [];
    const t0 = performance.now();
    const tick = () => {
      out.push(g.getImageData(Math.round(wx * k), Math.round(wy * k), 1, 1).data[1]);
      if (performance.now() - t0 < total) setTimeout(tick, step);
      else resolve(out);
    };
    tick();
  }), [durationMs, everyMs, WORLD.dangerY - 6, 20]);
}

scenario('m', '모션 줄이기: 경계선 경고가 깜빡이지 않는다 (기본 설정에서는 깜빡이고, 실행 중 전환도 반영)', { reducedMotion: 'reduce', ignore: [/willReadFrequently/] }, async (env) => {
  const { page } = env;
  await loadGame(env);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  await startGame(page);
  await pause(page);
  await pinAboveLine(page, 3, 200);
  await advance(page, TIMING.settleGrace + TIMING.overflow * 0.75);
  const { danger, state } = await gameInfo(page);
  assert.ok(danger >= 0.5 && danger < 1 && state !== 'GAME_OVER', `위험도 ${danger}`);

  const spread = (xs) => Math.max(...xs) - Math.min(...xs);
  const calm = await sampleDangerGlow(page);
  assert.equal(spread(calm), 0, `모션 줄이기인데 경고가 깜빡임: ${calm}`);
  // 깜빡이지 않아도 경고는 보여야 한다: 같은 가로줄의 경고 없는 자리보다 붉게(초록 채널이 낮게) 칠해진다
  const outside = await page.evaluate(() => {
    const c = document.getElementById('game-canvas');
    return c.getContext('2d').getImageData(Math.round(20 * c.width / 400), Math.round(20 * c.width / 400), 1, 1).data[1];
  });
  assert.ok(calm[0] < outside - 15, `경고 표시가 없음: 경계선 위 ${calm[0]}, 배경 ${outside}`);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const blink = await sampleDangerGlow(page);
  assert.ok(spread(blink) >= 15, `기본 설정에서는 깜빡여야 함: ${blink}`);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  const calmAgain = await sampleDangerGlow(page);
  assert.equal(spread(calmAgain), 0, `실행 중 모션 줄이기로 바꿨는데 깜빡임: ${calmAgain}`);
});

// ───────────────────────── 실행 ─────────────────────────

export async function runScenario(browser, server, sc) {
  const fakeApi = typeof sc.opts.fakeApi === 'function' ? sc.opts.fakeApi() : null;
  let env = null;
  let error = null;
  try {
    env = await openPage(browser, server, { ...sc.opts, fakeApi });
    env.fakeApi = fakeApi;
    await sc.fn(env);
  } catch (e) {
    error = e; // 준비 단계 실패도 한 시나리오의 FAIL 로 보고하고 나머지는 계속 돌린다
  }
  const issues = env ? remainingIssues(env) : [];
  await env?.ctx.close();
  return { error, issues };
}

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice(7).split(',') : null;
  const todo = scenarios.filter((s) => !only || only.includes(s.id));
  const server = await startServer();
  const browser = await launchBrowser();
  let failed = 0;
  const t0 = Date.now();
  try {
    for (const sc of todo) {
      const t = Date.now();
      const { error, issues } = await runScenario(browser, server, sc);
      const ok = !error && issues.length === 0;
      if (!ok) failed += 1;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.id.padEnd(3)} ${sc.title} (${Date.now() - t}ms)`);
      if (error) console.log(`       ${String(error.stack || error).split('\n').slice(0, 8).join('\n       ')}`);
      for (const i of issues) console.log(`       [${i.kind}] ${i.text}`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`\n${todo.length - failed}/${todo.length} scenarios passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
