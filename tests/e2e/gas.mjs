// Apps Script 배포 모의 e2e. 실제 gas/Code.gs 와 실제 gas/Index.html 을 Apps Script 가 하는 방식(과 최대한 비슷하게)으로 띄워 검증한다.
//
//   Node 쪽 "배포" (startDeployment)
//     - 진짜 gas/Code.gs 를 tests/helpers/gas-env.mjs 의 모의 서비스(시트/락/캐시/HtmlService …)와 함께 vm 에서 돌린다.
//     - 웹 앱 주소(/macros/s/TEST/exec)로 GET 이 오면 진짜 doGet(e) 를 부르고(action 없음), 돌려받은 HtmlOutput 으로
//       Apps Script 처럼 '바깥 래퍼 페이지'를 만든다: HtmlOutput 의 title / meta 태그(viewport) + 화면을 꽉 채우는 sandbox iframe.
//       iframe 안(/macros/s/TEST/userCodeAppPanel)에는 HtmlOutput.getContent() 가 그대로 들어간다.
//     - ?action=ranking, POST 같은 외부 JSON 요청도 같은 doGet/doPost 로 간다.
//   브라우저 쪽
//     - iframe 에만 window.google.script.run 흉내를 심는다(page.addInitScript). withSuccessHandler/withFailureHandler 는 호출마다
//       '새' 실행기를 돌려주고, 서버 함수 호출은 비동기이며, 인자는 JSON 으로 표현되는 값이어야 한다. 호출은 page.exposeFunction 을 거쳐
//       Node 의 진짜 apiRanking/apiSubmit 으로 간다 (tests/helpers/gas-env.mjs 의 createScriptRun).
//     - 시나리오마다 지연, 실패(failure 핸들러가 Error 를 받음), 응답 유실(서버는 처리했는데 답이 안 옴), 먹통(타임아웃), 이상한 결과를 주입할 수 있다.
//     - iframe 은 allow-same-origin 이 있는 것과 없는 것(localStorage 가 SecurityError) 두 가지로 모두 돌린다.
//     - 하네스 서버 밖으로 나가는 모든 요청은 막고, 있으면 실패로 친다. 콘솔 오류/경고, pageerror, 대화상자도 실패로 친다.
//
// 이 파일이 흉내 내는 Apps Script 동작은 공식 문서로 확인하지 못한 가정이다(보고서의 unverified 참고): iframe 래퍼의 정확한 모양,
// google.script.run 의 오류/직렬화 규칙, HtmlService 의 세부 동작.
//
// 사용: node tests/e2e/gas.mjs [--only=load,submit] [--headed] [--bail] [--shots=저장폴더]   (CHROMIUM_PATH 로 브라우저 지정)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadGas, createScriptRun, publicFunctions, HEADER } from '../helpers/gas-env.mjs';
import {
  launchBrowser, sleep, until,
  bodiesOf, stateOf, scoreOfPage, advance, pause, spawn, text, isVisible, lsGet,
  settleChecked, layoutMetrics, assertLayout,
} from './harness.mjs';
import { FRUITS, WORLD, TIMING, STORAGE_KEYS, scoreOf } from '../../js/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX_FILE = path.join(ROOT, 'gas/Index.html');
const BASE = '/macros/s/TEST';
const EXEC_PATH = `${BASE}/exec`;
const PANEL_PATH = `${BASE}/userCodeAppPanel`;
const FAKE_API_URL = `https://script.google.com${EXEC_PATH}`;
const FAKE_API_RE = /^https:\/\/script\.google\.com\/macros\/s\/TEST\/exec(\?.*)?$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const XSS_NICK = '<img src=x onerror=alert(1)>';
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-top-navigation-by-user-activation';
const VIEWPORT_META = 'width=device-width, initial-scale=1, viewport-fit=cover';
const ALLOWED_META = new Set(['viewport', 'apple-mobile-web-app-capable', 'google-site-verification', 'mobile-web-app-capable']); // HtmlOutput.addMetaTag 가 받는 이름
const PUBLIC_FUNCTIONS = ['apiRanking', 'apiSubmit', 'doGet', 'doPost', 'setup'];
const PENDING = { nickname: '보관', score: 77, maxLevel: 3, playTimeMs: 20000, drops: 12, clientId: 'abcdefghijklmnop1234' };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// ───────────────────────── Node 쪽 배포 ─────────────────────────

// 시트의 초기 행들 (헤더 + n 줄). 마지막 인자로 XSS 닉네임을 2등에 넣을 수 있다.
export function sampleSheet(n = 5, { xss = true } = {}) {
  const t0 = Date.UTC(2025, 11, 31);
  const rows = [HEADER.slice()];
  for (let i = 0; i < n; i++) {
    const nick = xss && i === 1 ? XSS_NICK : `플레이어${i + 1}`;
    rows.push([t0 + i * 60000, nick, 5000 - i * 321, 8 - (i % 5), 600000 + i * 1000, 400 + i, `seedclient${String(i).padStart(8, '0')}`]);
  }
  return rows;
}

// 시나리오 하나가 쓰는 '배포'. gas: 진짜 Code.gs, mocks: 모의 서비스 상태.
export async function startDeployment({ indexHtml, withIndex = true, rows, sameOrigin = true, iframeQuery = '?debug' } = {}) {
  const html = indexHtml ?? (await fs.readFile(INDEX_FILE, 'utf8'));
  const { gas, mocks } = loadGas({ files: withIndex ? { Index: html } : {}, rows });
  const dep = {
    gas,
    mocks,
    sameOrigin,
    iframeQuery,
    doGetCalls: [], // doGet 에 들어간 e.parameter 들
    doPostCalls: [],
    hits: [], // 하네스 서버가 받은 요청 { method, path, search }
    output: null, // 마지막 doGet 결과 (HtmlOutput 모의 또는 TextOutput 모의)
    origin: '', // 바깥 래퍼 페이지의 origin (script.google.com 에 해당)
    panelOrigin: '', // iframe 안 문서의 origin (*.googleusercontent.com 에 해당): 같은 서버지만 호스트 이름이 달라 서로 다른 origin 이다
    close: async () => {},
  };

  // 외부 JSON 요청(GET ?action=…, POST)을 진짜 doGet/doPost 로 처리한다. 페이지 요청(HtmlOutput)이면 output 에 저장한다.
  const callDoGet = (url) => {
    const parameter = {};
    const parameters = {};
    for (const [k, v] of url.searchParams) {
      if (!(k in parameter)) parameter[k] = v;
      (parameters[k] ??= []).push(v);
    }
    dep.doGetCalls.push({ ...parameter });
    return dep.gas.doGet({ parameter, parameters, queryString: url.search.slice(1), contextPath: '', contentLength: -1 });
  };
  const textResponse = (out) => ({
    status: 200,
    headers: { 'content-type': out.mime === 'JSON' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    body: out.getContent(),
  });
  dep.handleFetch = (method, url, body) => {
    if (method === 'POST') {
      dep.doPostCalls.push(body);
      return textResponse(dep.gas.doPost({ postData: { contents: body, type: 'text/plain' }, parameter: {} }));
    }
    return textResponse(callDoGet(url));
  };

  const wrapper = (out) => {
    const metas = out.getMetaTags().map((m) => {
      if (!ALLOWED_META.has(m.name)) throw new Error(`addMetaTag 가 받지 않는 이름: ${m.name}`);
      return `<meta name="${esc(m.name)}" content="${esc(m.content)}">`;
    });
    const sandbox = dep.sameOrigin ? `${SANDBOX} allow-same-origin` : SANDBOX;
    // Apps Script 의 바깥 페이지를 흉내 낸 것: 제목과 meta 는 HtmlOutput 에서 오고, 화면을 꽉 채우는 sandbox iframe 안에 사용자 HTML 이 들어간다.
    return `<!doctype html>
<html><head><meta charset="utf-8">
${metas.join('\n')}
<title>${esc(out.getTitle())}</title>
<link rel="icon" href="data:,">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#fff}iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:0}</style>
</head><body><iframe id="userHtmlFrame" sandbox="${sandbox}" src="${dep.panelOrigin}${PANEL_PATH}${dep.iframeQuery}"></iframe></body></html>`;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    dep.hits.push({ method: req.method, path: url.pathname, search: url.search });
    const send = (status, headers, body) => {
      res.writeHead(status, { 'cache-control': 'no-store', ...headers });
      res.end(body);
    };
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        if (url.pathname === EXEC_PATH && req.method === 'GET') {
          const out = callDoGet(url);
          dep.output = out;
          if (typeof out.getTitle === 'function') return send(200, { 'content-type': 'text/html; charset=utf-8' }, wrapper(out));
          const r = textResponse(out);
          return send(r.status, r.headers, r.body);
        }
        if (url.pathname === EXEC_PATH && req.method === 'POST') {
          const r = dep.handleFetch('POST', url, body);
          return send(r.status, r.headers, r.body);
        }
        if (url.pathname === PANEL_PATH && req.method === 'GET' && dep.output && typeof dep.output.getTitle === 'function') {
          return send(200, { 'content-type': 'text/html; charset=utf-8' }, dep.output.getContent());
        }
        return send(404, { 'content-type': 'text/plain' }, 'not found');
      } catch (err) {
        return send(500, { 'content-type': 'text/plain' }, String(err && err.stack));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  dep.origin = `http://127.0.0.1:${port}`;
  dep.panelOrigin = `http://localhost:${port}`;
  dep.url = dep.origin + EXEC_PATH;
  dep.close = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  return dep;
}

// ───────────────────────── google.script.run ↔ 진짜 Code.gs 다리 ─────────────────────────

// 서버 호출 한 건마다 모드를 정할 수 있다 (ctl.queue('apiSubmit', 'lost', 'ok')). 큐가 비면 'ok'.
//   ok          서버가 처리하고 결과가 돌아온다
//   fail        서버에 닿기 전에 실패: failure 핸들러가 Error 를 받는다 (서버는 실행되지 않음)
//   lost        서버는 처리했는데 응답이 유실돼 failure 핸들러가 Error 를 받는다
//   hang        답이 오지 않는다. ctl.releaseHung() 하면 그때 서버가 처리하고 '늦은 응답'이 도착한다
//   bad:<kind>  서버에 닿지 않고 success 핸들러가 이상한 값을 받는다 (html | null | noOk | number | emptyObject | truthyOk | stringOk)
// ctl.latencyMs(fn, args, index) 는 요청이 서버에 닿기까지, ctl.responseDelayMs(fn, args, index) 는 서버가 처리한 뒤 응답이 돌아오기까지의 지연이다.
const BAD_RESULTS = {
  html: '<html><body>로그인이 필요합니다</body></html>',
  null: null,
  noOk: { data: [] },
  number: 42,
  emptyObject: {},
  truthyOk: { ok: 1, data: [] }, // ok 가 불리언이 아니면 참처럼 보여도 성공으로 취급하면 안 된다
  stringOk: { ok: 'true' },
};

export function createController(dep) {
  const { run } = createScriptRun(publicFunctions(dep.gas));
  const names = Object.keys(publicFunctions(dep.gas)).sort();
  const queues = new Map();
  const counts = new Map();
  const hung = [];
  const ctl = {
    names,
    calls: [], // { fn, args, mode, outcome: null | 'success' | 'failure', result?, message? }
    latencyMs: 0,
    responseDelayMs: 0,
    queue(fn, ...modes) {
      queues.set(fn, [...(queues.get(fn) ?? []), ...modes]);
    },
    callsOf: (fn) => ctl.calls.filter((c) => c.fn === fn),
    releaseHung() {
      for (const release of hung.splice(0)) release();
    },
    async handle(fn, argsJson) {
      const args = JSON.parse(argsJson);
      const index = counts.get(fn) ?? 0;
      counts.set(fn, index + 1);
      const mode = queues.get(fn)?.shift() ?? 'ok';
      const call = { fn, args, mode, outcome: null };
      ctl.calls.push(call);
      const delay = (v) => (typeof v === 'function' ? v(fn, args, index) : v);
      const execute = () => new Promise((resolve) => {
        if (!names.includes(fn)) return resolve({ kind: 'failure', message: `Script function not found: ${fn}` });
        run
          .withSuccessHandler((result) => resolve({ kind: 'success', json: JSON.stringify(result) }))
          .withFailureHandler((err) => resolve({ kind: 'failure', message: String((err && err.message) || err) }))[fn](...args);
      });
      const failure = (message) => ({ kind: 'failure', message });
      const wait = delay(ctl.latencyMs);
      if (wait) await sleep(wait);

      let reply;
      if (mode === 'fail') reply = failure('Error: 서버에 연결하지 못했습니다');
      else if (mode === 'lost') {
        await execute();
        reply = failure('Error: 응답을 받지 못했습니다');
      } else if (mode === 'hang') {
        await new Promise((resolve) => hung.push(resolve));
        reply = await execute();
      } else if (mode.startsWith('bad:')) {
        const kind = mode.slice(4);
        assert.ok(kind in BAD_RESULTS, `알 수 없는 bad 종류 ${kind}`);
        reply = { kind: 'success', json: JSON.stringify(BAD_RESULTS[kind]) };
      } else {
        assert.equal(mode, 'ok', `알 수 없는 모드 ${mode}`);
        reply = await execute();
      }
      const after = delay(ctl.responseDelayMs);
      if (after) await sleep(after);
      call.outcome = reply.kind;
      if (reply.kind === 'success') call.result = JSON.parse(reply.json);
      else call.message = reply.message;
      return reply;
    },
  };
  return ctl;
}

// 브라우저 안 google.script.run 흉내 (iframe 에만 심는다). 직렬화해서 보내므로 바깥 변수를 쓰지 않는다.
function installGoogleStub({ names }) {
  if (window === window.top) return; // 바깥 래퍼 페이지에는 google.script 가 없다
  const legal = (v, p) => {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return;
    if (Array.isArray(v)) return v.forEach((x, i) => legal(x, `${p}[${i}]`));
    const proto = typeof v === 'object' ? Object.getPrototypeOf(v) : 0;
    if (proto === Object.prototype || proto === null) return Object.keys(v).forEach((k) => legal(v[k], `${p}.${k}`));
    throw new Error(`Failed due to illegal value in property: ${p}`);
  };
  const make = (state) => {
    const runner = {
      withSuccessHandler: (fn) => make({ ...state, success: fn }),
      withFailureHandler: (fn) => make({ ...state, failure: fn }),
      withUserObject: (userObject) => make({ ...state, userObject }),
    };
    for (const name of names) {
      runner[name] = (...args) => {
        args.forEach((a, i) => legal(a, String(i)));
        const json = JSON.stringify(args);
        window.__gasBridge(name, json).then(
          (reply) => setTimeout(() => {
            if (reply.kind === 'success') state.success?.(JSON.parse(reply.json), state.userObject);
            else state.failure?.(new Error(reply.message), state.userObject);
          }, 0),
          (err) => setTimeout(() => state.failure?.(new Error(String(err)), state.userObject), 0),
        );
      };
    }
    return runner;
  };
  window.google = { script: { run: make({}), host: { close() {}, setHeight() {}, setWidth() {} } } };
}

// ───────────────────────── 페이지 열기 ─────────────────────────

// opts: viewport, mobile, sameOrigin(기본 true), query(iframe URL 의 쿼리. 기본 '?debug', 운영 모습은 ''), noGoogle, apiUrl(번들의 API_URL 을 바꿔 fetch 통로를 켠다),
//       rows(시트 초기 행), withIndex, pending(iframe 의 localStorage 에 미리 넣을 점수), ignore(허용할 콘솔/요청 메시지 패턴)
export async function openGas(browser, o = {}) {
  const {
    viewport = { width: 1280, height: 720 },
    mobile = false,
    deviceScaleFactor = mobile ? 3 : 1,
    sameOrigin = true,
    query = '?debug',
    noGoogle = false,
    apiUrl = null,
    rows = sampleSheet(5),
    withIndex = true,
    pending = null,
    ignore = [],
    load = true,
  } = o;

  let indexHtml = await fs.readFile(INDEX_FILE, 'utf8');
  if (apiUrl) {
    const from = 'var API_URL = "";';
    assert.equal(indexHtml.split(from).length, 2, `번들에서 ${from} 를 하나만 찾아야 함 (테스트가 API_URL 을 바꾸지 못함)`);
    indexHtml = indexHtml.replace(from, () => `var API_URL = ${JSON.stringify(apiUrl)};`);
  }
  const dep = await startDeployment({ indexHtml, withIndex, rows, sameOrigin, iframeQuery: query });
  const ctl = createController(dep);
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor, locale: 'ko-KR' });
  ctx.setDefaultTimeout(10000); // 깨졌을 때 시나리오마다 30초씩 기다리지 않도록 (더 오래 걸리는 기다림은 시간을 직접 준다)

  const env = { ctx, dep, ctl, page: null, fr: null, issues: [], requests: [], fetches: [], ignore: [...ignore], dialogs: [], sameOrigin, apiUrl, closeAll: null };
  const push = (kind, msg) => env.issues.push({ kind, text: msg });

  // 하네스 서버 밖으로는 아무것도 나가지 못한다. (apiUrl 을 켠 시나리오의 가짜 API 주소만 Code.gs 로 연결한다.)
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith(dep.origin + '/') || url.startsWith(dep.panelOrigin + '/')) return route.continue();
    if (apiUrl && FAKE_API_RE.test(url)) {
      const headers = { 'access-control-allow-origin': '*' };
      if (req.method() === 'OPTIONS') {
        env.preflight = (env.preflight ?? 0) + 1;
        return route.fulfill({ status: 204, headers: { ...headers, 'access-control-allow-headers': '*' } });
      }
      const r = dep.handleFetch(req.method(), new URL(url), req.postData() ?? '');
      env.fetches.push({ method: req.method(), url, contentType: req.headers()['content-type'], body: req.postData() });
      return route.fulfill({ status: r.status, headers: { ...r.headers, ...headers }, body: r.body });
    }
    push('external-request', `${req.method()} ${url}`);
    return route.abort('blockedbyclient');
  });

  const page = await ctx.newPage();
  env.page = page;
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') push(`console.${m.type()}`, `${m.text()} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => push('pageerror', e.stack || e.message));
  page.on('requestfailed', (r) => {
    if (r.url().startsWith('data:')) return;
    push('requestfailed', `${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) push('http', `${r.status()} ${r.url()}`);
  });
  page.on('request', (r) => env.requests.push({ method: r.method(), url: r.url(), frame: r.frame().url() }));
  page.on('dialog', (d) => {
    env.dialogs.push(d.message());
    push('dialog', d.message());
    d.dismiss().catch(() => {});
  });

  try {
    await page.exposeFunction('__gasBridge', (fn, argsJson) => ctl.handle(fn, argsJson));
    if (!noGoogle) await page.addInitScript(installGoogleStub, { names: ctl.names });
    if (pending) {
      await page.addInitScript(([key, value]) => {
        if (window === window.top) return;
        try {
          if (sessionStorage.getItem('__e2e_seeded')) return;
          sessionStorage.setItem('__e2e_seeded', '1');
          localStorage.setItem(key, value);
        } catch { /* sandbox 에서는 저장소가 없다 */ }
      }, [STORAGE_KEYS.pending, JSON.stringify(pending)]);
    }
    if (load) await gotoGame(env, { debug: query.includes('debug') });
  } catch (err) {
    // 준비 중 실패해도 서버/컨텍스트가 남아 프로세스가 끝나지 않는 일이 없게 정리하고, 지금까지 모은 문제도 오류에 붙인다.
    await ctx.close().catch(() => {});
    await dep.close();
    const extra = remainingIssues(env).map((i) => `[${i.kind}] ${i.text}`);
    if (extra.length && err instanceof Error) err.message += `\n${extra.join('\n')}`;
    throw err;
  }
  return env;
}

// 웹 앱 주소로 이동하고 iframe 안의 게임이 뜰 때까지 기다린다.
export async function gotoGame(env, { debug = true, reload = false } = {}) {
  const { page } = env;
  if (reload) await page.reload();
  else await page.goto(env.dep.url);
  await page.waitForSelector('iframe#userHtmlFrame');
  env.fr = await (await page.locator('iframe#userHtmlFrame').elementHandle()).contentFrame();
  assert.ok(env.fr, 'iframe 의 frame 을 얻지 못함');
  if (debug) await env.fr.waitForFunction(() => !!window.__fruit);
  await env.fr.waitForFunction(() => document.getElementById('game-canvas')?.width > 100);
  await env.fr.evaluate(() => document.fonts?.ready);
}

export function remainingIssues(env) {
  const out = [...env.issues];
  // 하네스 서버가 받은 요청은 웹 앱 주소와 iframe 문서뿐이어야 한다 (CDN/폰트/스크립트 파일 요청이 없다는 뜻)
  const allowed = new Set([EXEC_PATH, PANEL_PATH]);
  for (const h of env.dep.hits) {
    if (!allowed.has(h.path)) out.push({ kind: 'unexpected-request', text: `${h.method} ${h.path}` });
  }
  for (const r of env.requests) {
    const u = new URL(r.url);
    if (u.protocol === 'data:' || u.origin === env.dep.origin || u.origin === env.dep.panelOrigin) continue;
    if (env.apiUrl && FAKE_API_RE.test(r.url)) continue;
    out.push({ kind: 'external-request', text: r.url });
  }
  return out.filter((i) => !env.ignore.some((re) => re.test(i.text)));
}

// ───────────────────────── 시나리오 도우미 ─────────────────────────

const sheetRows = (env) => env.dep.mocks.sheet.rows.slice(1);
const rowsOf = (env, clientId) => sheetRows(env).filter((r) => r[6] === clientId);
const submitStatus = (fr) => text(fr, '#submit-status');
const waitText = (fr, id, re, timeout = 5000) => fr.waitForFunction(([i, src]) => new RegExp(src).test(document.getElementById(i).textContent), [id, re.source], { timeout });
const wait = (fr, fn, arg, timeout = 5000) => fr.waitForFunction(fn, arg, { timeout });
const lsState = (fr) => fr.evaluate(() => { try { void localStorage.length; return 'ok'; } catch (e) { return e.name; } });
const tapOrClick = (env, sel) => (env.mobile ? env.fr.locator(sel).tap() : env.fr.locator(sel).click());

async function startGame(env) {
  await tapOrClick(env, '#btn-start');
  await env.fr.waitForFunction(() => window.__fruit.getState() === 'READY');
}

async function restartGame(env) {
  await tapOrClick(env, '#btn-restart');
  await env.fr.waitForFunction(() => window.__fruit.getState() === 'READY');
}

async function worldToClient(env, wx, wy = 300) {
  const box = await env.fr.locator('#game-canvas').boundingBox();
  return { x: box.x + (wx / WORLD.width) * box.width, y: box.y + (wy / WORLD.height) * box.height };
}

async function mouseDrop(env, wx) {
  const p = await worldToClient(env, wx);
  await env.page.mouse.move(p.x - 30, p.y);
  await env.page.mouse.move(p.x, p.y);
  await env.page.mouse.down();
  await env.page.mouse.up();
}

// 시작 → 실제 드롭 1회 → 일시정지 → 합치기 한 번 → 점수를 돌려준다. (게임오버는 호출하는 쪽이 만든다)
async function playAndMerge(env) {
  const { fr } = env;
  await startGame(env);
  await mouseDrop(env, 200);
  await pause(fr);
  await advance(fr, 3000);
  await fr.evaluate(() => window.__fruit.physics.clear());
  const r2 = FRUITS[2].radius;
  await spawn(fr, 2, 120, WORLD.height - r2);
  await spawn(fr, 2, 120 + 2 * r2 - 2, WORLD.height - r2);
  await advance(fr, 300);
  const score = await scoreOfPage(fr);
  assert.equal(score, scoreOf(3), '합치기 점수');
  return score;
}

async function gameOver(env) {
  await env.fr.evaluate(() => window.__fruit.forceGameOver());
  assert.ok(await isVisible(env.fr, '#screen-gameover'));
}

// 경계선 위에 고정한 과일 (static): 체류 시간이 지나면 게임오버
function pinAboveLine(fr, level = 3, x = 200) {
  return fr.evaluate(([l, px]) => {
    const info = window.__fruit.spawn(l, px, 40);
    const b = window.__fruit.physics.bodies().find((body) => body.id === info.id);
    Matter.Body.setStatic(b, true);
    return info.id;
  }, [level, x]);
}

const fitsInStage = (fr, sel) => fr.evaluate((s) => {
  const p = document.querySelector(s).getBoundingClientRect();
  const st = document.getElementById('stage').getBoundingClientRect();
  return p.left >= st.left - 0.5 && p.right <= st.right + 0.5 && p.top >= st.top - 0.5 && p.bottom <= st.bottom + 0.5;
}, sel);

// ───────────────────────── 시나리오 ─────────────────────────

const MODES = [
  { id: 'same', sameOrigin: true },
  { id: 'opaque', sameOrigin: false },
];
const scenarios = [];
// opts.modes: 돌릴 iframe 종류(기본: 둘 다). 나머지 opts 는 openGas 로 간다. opts.noPage: 브라우저 페이지를 열지 않는다.
const scenario = (id, title, opts, fn) => scenarios.push({ id, title, opts, fn });

scenario('load', '로드: 래퍼(title/viewport meta) + sandbox iframe 안에 게임, Matter 는 인라인 사본, 외부 요청 없음, 공개 함수 목록', {}, async (env) => {
  const { page, fr, dep } = env;
  // 진짜 doGet 이 action 없이 한 번 불렸고 Index 파일을 읽었다
  assert.deepEqual(dep.doGetCalls, [{}], 'doGet 은 파라미터 없이 한 번 불려야 함');
  assert.deepEqual(dep.mocks.html.requested, ['Index']);
  assert.equal(dep.output.getTitle(), '수박 합치기');
  // 바깥 래퍼: 제목, viewport meta (서버가 넣은 것), 꽉 찬 iframe
  assert.equal(await page.title(), '수박 합치기');
  assert.equal(await page.locator('meta[name=viewport]').getAttribute('content'), VIEWPORT_META);
  const sandbox = await page.locator('iframe#userHtmlFrame').getAttribute('sandbox');
  assert.equal(sandbox.split(' ').includes('allow-same-origin'), env.sameOrigin);
  assert.equal(await page.evaluate(() => typeof window.google), 'undefined', '바깥 페이지에 google 이 있으면 안 됨');
  const vp = page.viewportSize();
  const box = await page.locator('iframe#userHtmlFrame').boundingBox();
  assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, vp.width, vp.height], 'iframe 이 화면을 꽉 채워야 함');
  // iframe 안
  assert.equal(await fr.title(), '수박 합치기');
  assert.equal(await fr.evaluate(() => document.compatMode), 'CSS1Compat', '표준 모드가 아님');
  assert.equal(await fr.evaluate(() => window.origin === 'null'), !env.sameOrigin);
  assert.equal(await fr.evaluate(() => location.origin), dep.panelOrigin);
  assert.notEqual(dep.panelOrigin, dep.origin, '바깥 페이지와 iframe 은 서로 다른 origin 이어야 함 (script.google.com / googleusercontent.com)');
  assert.equal(await lsState(fr), env.sameOrigin ? 'ok' : 'SecurityError');
  assert.ok(await isVisible(fr, '#screen-start'));
  assert.ok(await fr.locator('#btn-start').isEnabled());
  assert.ok(!(await isVisible(fr, '#start-error')));
  assert.equal(await fr.evaluate(() => typeof Matter), 'object', 'Matter 가 없음');
  assert.equal(await fr.evaluate(() => Matter.version), '0.19.0');
  assert.equal(await stateOf(fr), 'IDLE');
  assert.equal(await fr.locator('#evolution-list > li').count(), FRUITS.length);
  const alpha = await fr.evaluate(() => {
    const c = document.getElementById('game-canvas');
    return c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data[3];
  });
  assert.equal(alpha, 255, '캔버스가 비어 있음');
  // 외부 자원이 없다: 스크립트는 모두 인라인, 스타일시트는 <style> 하나, 하네스에는 문서 두 개만 요청됐다
  const res = await fr.evaluate(() => ({
    scripts: [...document.scripts].map((s) => s.src),
    styles: document.querySelectorAll('style').length,
    links: [...document.querySelectorAll('link')].map((l) => `${l.rel}:${l.href.slice(0, 20)}`),
    imgs: [...document.images].map((i) => i.src),
  }));
  assert.ok(res.scripts.length >= 2 && res.scripts.every((s) => s === ''), `외부 스크립트: ${JSON.stringify(res.scripts)}`);
  assert.equal(res.styles, 1);
  assert.ok(res.links.every((l) => l.startsWith('icon:data:')), `외부 link: ${JSON.stringify(res.links)}`);
  assert.deepEqual(res.imgs, []);
  assert.deepEqual(dep.hits.map((h) => `${h.method} ${h.path}`), [`GET ${EXEC_PATH}`, `GET ${PANEL_PATH}`]);
  assert.ok(!env.requests.some((r) => /cdnjs|jsdelivr|unpkg|googleapis|gstatic/.test(r.url)), 'CDN 요청이 있음');
  // google.script.run: 공개 함수만, 이름이 밑줄로 끝나는 비공개 함수는 없다
  const surface = await fr.evaluate(() => Object.keys(google.script.run).sort());
  const handlers = ['withFailureHandler', 'withSuccessHandler', 'withUserObject'];
  assert.deepEqual(surface.filter((k) => !handlers.includes(k)), PUBLIC_FUNCTIONS);
  assert.ok(!surface.some((k) => k.endsWith('_')));
  // 디버그 훅이 있는 건 iframe 주소에 ?debug 를 붙였기 때문 (테스트 전용)
  assert.equal(await fr.evaluate(() => typeof window.__fruit), 'object');
  assert.equal(await page.evaluate(() => typeof window.__fruit), 'undefined');
  assert.equal(env.ctl.calls.length, 0, '시작만 했는데 서버 호출이 있음');
});

for (const v of [
  { id: 'mobile 390x844', viewport: { width: 390, height: 844 }, mobile: true },
  { id: 'desktop 1280x720', viewport: { width: 1280, height: 720 }, mobile: false },
]) {
  scenario(`layout-${v.viewport.width}`, `레이아웃 ${v.id}: iframe 안에서 스크롤 없이 전부 보이고, 탭/클릭으로 플레이된다`, {
    viewport: v.viewport, mobile: v.mobile, rows: sampleSheet(10),
  }, async (env) => {
    const { page, fr } = env;
    env.mobile = v.mobile;
    // 서버가 넣은 viewport meta 가 먹었는지: 모바일에서 레이아웃 뷰포트가 기기 폭이어야 한다 (meta 가 없으면 980px)
    const top = await page.evaluate(() => ({ iw: innerWidth, ih: innerHeight, scale: visualViewport.scale, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
    assert.deepEqual([top.iw, top.ih], [v.viewport.width, v.viewport.height], `바깥 페이지 뷰포트 ${JSON.stringify(top)}`);
    assert.equal(top.scale, 1);
    assert.ok(top.sw <= top.iw && top.sh <= top.ih, `바깥 페이지가 스크롤됨 ${JSON.stringify(top)}`);
    const inner = await fr.evaluate(() => [innerWidth, innerHeight]);
    assert.deepEqual(inner, [v.viewport.width, v.viewport.height], 'iframe 이 화면을 채우지 못함');

    assertLayout(await layoutMetrics(fr), `${v.id} 시작 화면`);
    assert.ok(await fitsInStage(fr, '#screen-start .panel'), '시작 패널이 게임판 밖으로 나감');
    await tapOrClick(env, '#btn-start');
    await fr.waitForFunction(() => window.__fruit.getState() === 'READY');
    assert.equal((await bodiesOf(fr)).length, 0, '시작 탭이 드롭이 되면 안 됨');
    assertLayout(await layoutMetrics(fr), `${v.id} 플레이 중`);

    const p = await worldToClient(env, 90, 250);
    if (v.mobile) await page.touchscreen.tap(p.x, p.y);
    else await page.mouse.click(p.x, p.y);
    const bs = await bodiesOf(fr);
    assert.equal(bs.length, 1, '탭/클릭으로 드롭되어야 함');
    assert.ok(Math.abs(bs[0].x - 90) < 3, `드롭 x=${bs[0].x}`);
    await pause(fr);
    await settleChecked(fr, 3000);
    await fr.evaluate(() => window.scrollTo(0, 400));
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(50);
    assertLayout(await layoutMetrics(fr), `${v.id} 스크롤 시도 후`);
    assert.equal(await page.evaluate(() => scrollY + scrollX), 0, '바깥 페이지가 스크롤됨');

    await gameOver(env);
    await wait(fr, () => document.querySelectorAll('#ranking-list > li').length === 10);
    assert.ok(await fitsInStage(fr, '#screen-gameover .panel'), '게임오버 패널이 게임판 밖으로 나감');
    assert.ok(await fitsInStage(fr, '#btn-restart'), '다시 하기 버튼이 보이지 않음');
    assert.ok(await fitsInStage(fr, '#btn-submit'), '랭킹 등록 버튼이 보이지 않음');
    assertLayout(await layoutMetrics(fr), `${v.id} 게임오버`);
    await tapOrClick(env, '#btn-restart');
    await fr.waitForFunction(() => window.__fruit.getState() === 'READY');
    assert.equal((await bodiesOf(fr)).length, 0);
  });
}

scenario('play', '플레이: 드롭 → 합치기 → 넘쳐서 게임오버 (결정적), 최고점은 저장 또는 메모리에 유지', {}, async (env) => {
  const { fr } = env;
  await startGame(env);
  assert.equal((await bodiesOf(fr)).length, 0, '시작 클릭이 드롭으로 이어지면 안 됨');
  await mouseDrop(env, 123);
  let bs = await bodiesOf(fr);
  assert.equal(bs.length, 1);
  assert.ok(Math.abs(bs[0].x - 123) < 2.5, `드롭 x ${bs[0].x}`);
  await fr.waitForFunction(() => window.__fruit.bodies()[0].y > 250, null, { timeout: 5000 }); // 실시간 루프로 실제 낙하
  await pause(fr);
  await settleChecked(fr, 4000);
  assert.equal(await stateOf(fr), 'READY');

  // 합치기: 같은 단계 한 쌍 -> 한 단계 위 하나
  await fr.evaluate(() => window.__fruit.physics.clear());
  const r = FRUITS[3].radius;
  await spawn(fr, 3, 160, WORLD.height - r);
  await spawn(fr, 3, 160 + 2 * r - 2, WORLD.height - r);
  await advance(fr, 100);
  bs = await bodiesOf(fr);
  assert.equal(bs.length, 1);
  assert.equal(bs[0].level, 4);
  assert.equal(await scoreOfPage(fr), scoreOf(4));
  assert.equal(await text(fr, '#score'), String(scoreOf(4)));

  // 넘침: 경계선 위에 고정된 과일이 유예 + 체류 시간을 넘기면 게임오버
  await pinAboveLine(fr, 3, 300);
  await advance(fr, TIMING.settleGrace - 100);
  assert.ok(['READY', 'COOLDOWN'].includes(await stateOf(fr)), '유예 시간 안에 게임오버가 됨');
  await advance(fr, 100 + TIMING.overflow + 100);
  assert.equal(await stateOf(fr), 'GAME_OVER');
  assert.ok(await isVisible(fr, '#screen-gameover'));
  assert.equal(await text(fr, '#final-score'), String(scoreOf(4)));
  assert.ok(await isVisible(fr, '#new-record'));
  assert.equal(await text(fr, '#best'), String(scoreOf(4)));
  if (env.sameOrigin) assert.equal(await lsGet(fr, STORAGE_KEYS.best), String(scoreOf(4)));
  // 다시 하기: 초기화되지만 최고점은 남는다 (저장소가 막힌 iframe 에서는 메모리 사본이 유지한다)
  await restartGame(env);
  assert.equal(await text(fr, '#score'), '0');
  assert.equal(await text(fr, '#best'), String(scoreOf(4)));
  assert.equal((await bodiesOf(fr)).length, 0);
  await pause(fr);
  await gameOver(env);
  assert.ok(!(await isVisible(fr, '#new-record')), '점수 0 은 신기록이 아님');
  assert.equal(await text(fr, '#final-best'), String(scoreOf(4)));
  assert.deepEqual(env.dialogs, []);
});

scenario('ranking', '랭킹 보기: 진짜 Code.gs 의 시트 행이 google.script.run.apiRanking 으로 와서 (정렬/제한/XSS 안전) 그려진다', {
  rows: [...sampleSheet(12), ['2025-12-31T00:00:00.000Z', '망가진행', 'abc', 1, 1, 1, ''], [1, '', 5, 1, 1, 1, '']],
}, async (env) => {
  const { fr, dep, ctl } = env;
  await fr.click('#btn-view-ranking');
  await wait(fr, () => document.querySelectorAll('#ranking-view-list > li').length === 10);
  assert.equal(await fr.locator('#ranking-view-list img').count(), 0, 'img 태그가 만들어지면 안 됨');
  const names = await fr.locator('#ranking-view-list > li > :nth-child(2)').allInnerTexts();
  assert.equal(names.length, 10);
  assert.equal(names[0], '플레이어1');
  assert.equal(names[1], XSS_NICK, 'XSS 닉네임은 글자 그대로');
  assert.ok(!names.includes('망가진행'));
  const first = await fr.locator('#ranking-view-list > li:first-child').innerText();
  assert.match(first, /5,000/);
  assert.deepEqual(env.dialogs, []);
  // 서버 호출: google.script.run.apiRanking(10) 한 번, 서버 캐시에 올라감, fetch 는 쓰지 않음
  assert.deepEqual(ctl.calls.map((c) => [c.fn, c.args]), [['apiRanking', [10]]]);
  assert.equal(dep.mocks.cachePuts.filter((p) => p.key === 'ranking').length, 1);
  const reads = dep.mocks.sheet.reads;
  await env.page.keyboard.press('Escape');
  assert.ok(await isVisible(fr, '#screen-start'));
  await fr.click('#btn-view-ranking');
  await wait(fr, () => document.querySelectorAll('#ranking-view-list > li').length === 10);
  assert.equal(ctl.callsOf('apiRanking').length, 2);
  assert.equal(dep.mocks.sheet.reads, reads, '두 번째 조회는 서버 캐시에서 와야 함 (시트를 다시 읽지 않음)');
  assert.deepEqual(dep.hits.map((h) => h.path), [EXEC_PATH, PANEL_PATH]);

  // 랭킹 호출이 실패하면 안내 문구, 게임은 계속
  await env.page.keyboard.press('Escape');
  ctl.queue('apiRanking', 'fail');
  await fr.click('#btn-view-ranking');
  await waitText(fr, 'ranking-view-status', /불러오지 못했어요/);
  assert.equal(await fr.locator('#ranking-view-list > li').count(), 0);
  await env.page.keyboard.press('Escape');
  await startGame(env);
  await mouseDrop(env, 200);
  assert.equal((await bodiesOf(fr)).length, 1);
});

scenario('ranking-empty', '랭킹 보기: 빈 시트는 안내 문구, 시트가 없는 배포는 실패 문구(내부 오류를 숨긴 server_busy)', { rows: [HEADER.slice()] }, async (env) => {
  const { fr, dep, ctl } = env;
  await fr.click('#btn-view-ranking');
  await waitText(fr, 'ranking-view-status', /첫 기록/);
  await env.page.keyboard.press('Escape');
  dep.mocks.props.delete('SHEET_ID'); // setup() 을 안 한 배포
  dep.mocks.cache.clear();
  await fr.click('#btn-view-ranking');
  await waitText(fr, 'ranking-view-status', /불러오지 못했어요/);
  assert.equal(ctl.callsOf('apiRanking').at(-1).result.error, 'server_busy');
  assert.ok(dep.mocks.errors.some((e) => /SHEET_ID/.test(e)), '원인은 실행 로그에만 남는다');
  assert.ok(!(await fr.evaluate(() => document.body.innerText)).includes('SHEET_ID'), '내부 오류 상세가 화면에 보임');
});

scenario('submit', '점수 등록: google.script.run.apiSubmit 으로 가서 랭킹과 모의 시트(7열)에 새 줄이 생긴다', {}, async (env) => {
  const { fr, dep, ctl } = env;
  const before = sheetRows(env).length;
  const score = await playAndMerge(env);
  await gameOver(env);
  await wait(fr, () => document.querySelectorAll('#ranking-list > li').length === 5);
  assert.ok(await isVisible(fr, '#submit-form'), '제출 폼이 보여야 함');

  await fr.fill('#input-nickname', '   ');
  await fr.click('#btn-submit');
  assert.equal(ctl.callsOf('apiSubmit').length, 0, '빈 닉네임은 서버로 보내지 않는다');
  assert.match(await submitStatus(fr), /닉네임/);

  await fr.fill('#input-nickname', '테스터');
  await fr.click('#btn-submit');
  await wait(fr, () => document.getElementById('btn-submit').textContent === '등록 완료');
  assert.ok(await fr.locator('#btn-submit').isDisabled());
  assert.match(await submitStatus(fr), /등록했어요/);

  // 서버: 정확히 한 줄이 늘었고 7열
  const rows = sheetRows(env);
  assert.equal(rows.length, before + 1);
  const row = rows.at(-1);
  assert.equal(row.length, 7, '시트 열 수');
  assert.ok(row[0] instanceof Date, `timestamp ${row[0]}`);
  assert.deepEqual(row.slice(1, 6).map((v, i) => (i === 0 ? v : typeof v)), ['테스터', 'number', 'number', 'number', 'number']);
  assert.equal(row[2], score);
  assert.equal(row[5], 1, 'drops');
  assert.ok(row[4] >= 3000, `playTimeMs ${row[4]}`);
  assert.match(row[6], CLIENT_ID_RE);
  if (env.sameOrigin) assert.equal(row[6], await lsGet(fr, STORAGE_KEYS.clientId));
  assert.equal(dep.mocks.props.get('NICKNAME_TEXT_FORMAT'), 'sheet-id-0001', '닉네임 열 서식이 적용됨');

  // 클라이언트가 보낸 것
  const submits = ctl.callsOf('apiSubmit');
  assert.equal(submits.length, 1);
  assert.deepEqual(Object.keys(submits[0].args[0]).sort(), ['clientId', 'drops', 'maxLevel', 'nickname', 'playTimeMs', 'score']);
  assert.equal(submits[0].args.length, 1);
  assert.deepEqual(submits[0].result, { ok: true });
  assert.equal(submits[0].args[0].clientId, row[6]);

  // 랭킹: 서버가 캐시를 비웠고, 화면 목록에 새 줄이 있다
  assert.ok(dep.mocks.cacheRemoves.includes('ranking'));
  await wait(fr, () => document.querySelectorAll('#ranking-list > li').length === 6 && /테스터/.test(document.getElementById('ranking-list').textContent));
  const apiRank = ctl.callsOf('apiRanking');
  assert.ok(apiRank.length >= 2 && apiRank.every((c) => c.result.ok));
  assert.ok(apiRank.at(-1).result.data.some((d) => d.nickname === '테스터' && d.score === score));

  // 성공 뒤에는 다시 보낼 수 없다
  await fr.locator('#input-nickname').evaluate((el) => el.form.requestSubmit());
  await env.page.waitForTimeout(150);
  assert.equal(ctl.callsOf('apiSubmit').length, 1, '성공 뒤 중복 제출됨');
  if (env.sameOrigin) assert.equal(await lsGet(fr, STORAGE_KEYS.pending), null);
  assert.deepEqual(dep.hits.map((h) => h.path), [EXEC_PATH, PANEL_PATH], 'fetch 같은 다른 통로를 쓰면 안 됨');
});

scenario('throttle', '두 판 연속 등록: 두 번째는 빈도 제한(throttled) 안내 + 다시 시도, 시간이 지나면 등록되고 닉네임은 안전하게 저장된다', {}, async (env) => {
  const { fr, dep, ctl } = env;
  await playAndMerge(env);
  await gameOver(env);
  await fr.fill('#input-nickname', '첫판');
  await fr.click('#btn-submit');
  await wait(fr, () => document.getElementById('btn-submit').textContent === '등록 완료');
  const before = sheetRows(env).length;

  await restartGame(env);
  await mouseDrop(env, 250);
  await pause(fr);
  await advance(fr, 2500);
  await gameOver(env);
  await fr.fill('#input-nickname', '-_-');
  await fr.click('#btn-submit');
  await waitText(fr, 'submit-status', /너무 자주/);
  assert.ok(await fr.locator('#btn-submit').isEnabled());
  assert.equal(await text(fr, '#btn-submit'), '다시 시도');
  assert.equal(sheetRows(env).length, before, '빈도 제한에 걸렸는데 줄이 늘어남');
  assert.equal(ctl.callsOf('apiSubmit').at(-1).result.error, 'throttled');
  if (env.sameOrigin) assert.equal(JSON.parse(await lsGet(fr, STORAGE_KEYS.pending)).nickname, '-_-');

  dep.mocks.now += 11000; // 서버 시계가 10초를 넘긴다
  await fr.click('#btn-submit');
  await wait(fr, () => document.getElementById('btn-submit').textContent === '등록 완료');
  assert.equal(sheetRows(env).length, before + 1);
  assert.equal(sheetRows(env).at(-1)[1], "'-_-", '시트에는 수식 방지 접두 따옴표가 붙는다');
  await wait(fr, () => /-_-/.test(document.getElementById('ranking-list').textContent));
  const shown = await fr.locator('#ranking-list > li > :nth-child(2)').allInnerTexts();
  assert.ok(shown.includes('-_-'), `랭킹에는 원래 닉네임으로 보여야 함: ${JSON.stringify(shown)}`);
  if (env.sameOrigin) assert.equal(await lsGet(fr, STORAGE_KEYS.pending), null);
});

scenario('idempotent', '멱등: 응답이 유실된 뒤 재시도, 빠른 더블 클릭, google.script.run 직접 중복 호출 모두 시트에 한 줄만 남는다', {}, async (env) => {
  const { fr, dep, ctl } = env;
  const base = sheetRows(env).length;
  await playAndMerge(env);
  await gameOver(env);
  await fr.fill('#input-nickname', '유실');

  // 1) 서버는 저장했는데 응답이 오지 않는다 -> 클라이언트는 실패로 본다 -> 재시도하면 이미 기록된 것으로 성공 처리
  ctl.queue('apiSubmit', 'lost', 'ok');
  await fr.click('#btn-submit');
  await waitText(fr, 'submit-status', /네트워크/);
  assert.ok(await fr.locator('#btn-submit').isEnabled(), '응답 유실 뒤 버튼이 다시 열려야 함');
  assert.equal(await text(fr, '#btn-submit'), '다시 시도');
  assert.equal(sheetRows(env).length, base + 1, '서버는 이미 저장했다');
  if (env.sameOrigin) assert.equal(JSON.parse(await lsGet(fr, STORAGE_KEYS.pending)).nickname, '유실');
  await fr.click('#btn-submit');
  await wait(fr, () => document.getElementById('btn-submit').textContent === '등록 완료');
  assert.equal(sheetRows(env).length, base + 1, '재시도가 중복 줄을 만들었다');
  const submits = ctl.callsOf('apiSubmit');
  assert.deepEqual(submits.map((c) => c.outcome), ['failure', 'success']);
  assert.deepEqual(submits[0].args, submits[1].args, '재시도는 같은 내용을 보내야 함');
  assert.deepEqual(submits[1].result, { ok: true });
  if (env.sameOrigin) assert.equal(await lsGet(fr, STORAGE_KEYS.pending), null);

  // 2) google.script.run 으로 같은 내용을 동시에 두 번 직접 보낸다 (서버 쪽 멱등)
  const payload = submits[0].args[0];
  const results = await fr.evaluate((p) => Promise.all([0, 1].map(() => new Promise((resolve) => {
    google.script.run.withSuccessHandler(resolve).withFailureHandler((e) => resolve({ failure: e.message })).apiSubmit(p);
  }))), payload);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.equal(sheetRows(env).length, base + 1, '직접 중복 호출이 줄을 늘림');
  assert.equal(rowsOf(env, payload.clientId).length, 1);

  // 3) 다음 판: 응답이 느린 동안 더블 클릭/Enter 를 연타해도 서버 호출은 한 번
  dep.mocks.now += 11000;
  await restartGame(env);
  await mouseDrop(env, 90);
  await pause(fr);
  await advance(fr, 2500);
  await gameOver(env);
  await fr.fill('#input-nickname', '연타');
  ctl.latencyMs = 250;
  const callsBefore = ctl.callsOf('apiSubmit').length;
  await fr.evaluate(() => {
    const btn = document.getElementById('btn-submit');
    btn.click();
    btn.click();
    document.getElementById('submit-form').requestSubmit();
  });
  await wait(fr, () => document.getElementById('btn-submit').textContent === '등록 완료', null, 8000);
  ctl.latencyMs = 0;
  assert.equal(ctl.callsOf('apiSubmit').length, callsBefore + 1, '연타가 서버 호출을 여러 번 만들었다');
  assert.equal(sheetRows(env).length, base + 2);
});

scenario('failure', '실패 경로: failure 핸들러(Error), 이상한 결과(HTML/null/ok 없음/숫자/불리언 아닌 ok) -> 다시 시도 가능, 보관, 성공하면 정리', {}, async (env) => {
  const { fr, ctl } = env;
  const base = sheetRows(env).length;
  await playAndMerge(env);
  await gameOver(env);
  await fr.fill('#input-nickname', '실패');
  const attempt = async (mode, re) => {
    ctl.queue('apiSubmit', mode);
    await fr.click('#btn-submit');
    await waitText(fr, 'submit-status', re);
    assert.ok(await fr.locator('#btn-submit').isEnabled(), `${mode} 뒤 버튼이 다시 열려야 함`);
    assert.equal(await text(fr, '#btn-submit'), '다시 시도');
    assert.equal(sheetRows(env).length, base, `${mode} 인데 줄이 늘어남`);
    if (env.sameOrigin) {
      const pending = JSON.parse(await lsGet(fr, STORAGE_KEYS.pending));
      assert.equal(pending.nickname, '실패');
      assert.equal(pending.score, scoreOf(3));
    }
  };
  await attempt('fail', /네트워크/);
  await fr.evaluate(() => { document.getElementById('submit-status').textContent = ''; });
  await attempt('bad:html', /이해하지 못했어요/);
  await fr.evaluate(() => { document.getElementById('submit-status').textContent = ''; });
  await attempt('bad:null', /이해하지 못했어요/);
  await fr.evaluate(() => { document.getElementById('submit-status').textContent = ''; });
  await attempt('bad:noOk', /이해하지 못했어요/);
  await fr.evaluate(() => { document.getElementById('submit-status').textContent = ''; });
  await attempt('bad:number', /이해하지 못했어요/);
  await fr.evaluate(() => { document.getElementById('submit-status').textContent = ''; });
  await attempt('bad:emptyObject', /이해하지 못했어요/);
  await fr.evaluate(() => { document.getElementById('submit-status').textContent = ''; });
  await attempt('bad:truthyOk', /이해하지 못했어요/);
  await fr.evaluate(() => { document.getElementById('submit-status').textContent = ''; });
  await attempt('bad:stringOk', /이해하지 못했어요/);

  await fr.click('#btn-submit');
  await wait(fr, () => document.getElementById('btn-submit').textContent === '등록 완료');
  assert.equal(sheetRows(env).length, base + 1);
  if (env.sameOrigin) assert.equal(await lsGet(fr, STORAGE_KEYS.pending), null, '성공하면 보관분을 지운다');
  assert.deepEqual(ctl.callsOf('apiSubmit').map((c) => c.outcome), ['failure', ...Array(8).fill('success')]);
});

scenario('server-errors', '서버 오류 코드는 그대로 전달된다: invalid_nickname 은 닉네임 수정 안내, implausible 은 재시도 없음', {}, async (env) => {
  const { fr, ctl } = env;
  await startGame(env);
  await mouseDrop(env, 200);
  await pause(fr);
  await advance(fr, 1000);
  await gameOver(env);
  await fr.fill('#input-nickname', '\u200b\u202e\u200b'); // 눈에 안 보이는 글자만 (서버가 거절)
  await fr.click('#btn-submit');
  await waitText(fr, 'submit-status', /사용할 수 없는 닉네임/);
  assert.ok(await fr.locator('#btn-submit').isEnabled(), '닉네임만 고치면 되는 오류는 버튼이 열려야 함');
  assert.equal(ctl.callsOf('apiSubmit').at(-1).result.error, 'invalid_nickname');
  assert.equal(sheetRows(env).length, 5);

  // 개연성 없는 기록(드롭 1번에 165점): 재시도해도 소용없다 (버튼이 다시 열리지 않고 보관하지 않는다)
  await restartGame(env);
  await mouseDrop(env, 200);
  await pause(fr);
  const r8 = FRUITS[8].radius;
  for (let i = 0; i < 3; i++) {
    await fr.evaluate(() => window.__fruit.physics.clear());
    await spawn(fr, 8, 100, WORLD.height - r8);
    await spawn(fr, 8, 100 + 2 * r8 - 2, WORLD.height - r8);
    await advance(fr, 100);
  }
  assert.equal(await scoreOfPage(fr), 3 * scoreOf(9));
  await advance(fr, 1000);
  await gameOver(env);
  await fr.fill('#input-nickname', '치트');
  await fr.click('#btn-submit');
  await waitText(fr, 'submit-status', /등록할 수 없어요/);
  assert.equal(ctl.callsOf('apiSubmit').at(-1).result.error, 'implausible');
  assert.ok(await fr.locator('#btn-submit').isDisabled());
  if (env.sameOrigin) assert.equal(await lsGet(fr, STORAGE_KEYS.pending), null);
  assert.equal(sheetRows(env).length, 5, '개연성 없는 기록이 시트에 들어감');
});

scenario('concurrent', '동시 호출: 앞선 느린 랭킹 응답, 빠른 등록 응답, 뒤늦게 시작한 더 느린 랭킹 응답이 서로 섞이지 않는다 (호출마다 새 핸들러)', {}, async (env) => {
  const { fr, ctl } = env;
  await playAndMerge(env);
  // 서버는 곧바로 처리하지만 응답이 늦게 도착한다: 게임오버 직후의 랭킹 조회(A) 1.2초, 등록 뒤의 랭킹 조회(C) 2초
  ctl.responseDelayMs = (fn, args, index) => (fn === 'apiRanking' ? [1200, 2000][index] ?? 0 : 0);
  await gameOver(env);
  await fr.fill('#input-nickname', '동시');
  await fr.click('#btn-submit'); // B: 등록은 빠르게 끝난다
  await wait(fr, () => document.getElementById('btn-submit').textContent === '등록 완료', null, 4000);
  const [a, c] = ctl.callsOf('apiRanking');
  assert.equal(a.outcome, null, '첫 랭킹 응답이 아직 오지 않은 상태에서 등록이 끝나야 이 시나리오가 의미 있다');
  assert.match(await submitStatus(fr), /등록했어요/);
  assert.ok(c, '등록 성공 뒤 랭킹을 다시 불러와야 함');
  // A 의 늦은 응답(새 줄이 없는 5줄)이 도착해도, 아직 C 가 오지 않았으니 목록은 비어 있고 문구는 '불러오는 중'이어야 한다
  await until(() => a.outcome === 'success', '첫 랭킹 응답 도착', 4000);
  assert.equal(a.result.data.length, 5);
  assert.equal(c.outcome, null, 'C 가 A 보다 먼저 끝나면 이 시나리오가 의미 없다');
  await env.page.waitForTimeout(250);
  assert.equal(await fr.locator('#ranking-list > li').count(), 0, '다른 호출의 응답이 목록을 그렸다 (핸들러가 섞임)');
  assert.match(await text(fr, '#ranking-status'), /불러오는 중/);
  assert.match(await submitStatus(fr), /등록했어요/);
  // C 의 응답이 도착하면 새 줄이 포함된 6줄
  await wait(fr, () => document.querySelectorAll('#ranking-list > li').length === 6 && /동시/.test(document.getElementById('ranking-list').textContent), null, 6000);
  assert.equal(c.result.data.length, 6);
  assert.equal(await text(fr, '#btn-submit'), '등록 완료');
  assert.equal(ctl.callsOf('apiSubmit').length, 1);
});

scenario('boot-pending', '부팅 때 보관된 점수를 google.script.run 으로 조용히 재전송: 응답 유실 후 다시 열어도 한 줄만, 영구 오류면 지운다', {
  modes: ['same'], pending: PENDING,
}, async (env) => {
  const { ctl } = env; // 다시 로드하면 iframe 의 frame 이 새로 만들어지므로 env.fr 을 매번 읽는다
  // (픽스처 때문에 이미 한 번 로드됐다: 아래 reload 가 두 번째 부팅. 첫 부팅의 호출은 'ok' 로 처리되어 보관분이 지워졌다.)
  await until(() => ctl.callsOf('apiSubmit').length === 1, '부팅 재전송');
  assert.deepEqual(ctl.callsOf('apiSubmit')[0].args, [PENDING]);
  await env.fr.waitForFunction((k) => localStorage.getItem(k) === null, STORAGE_KEYS.pending);
  assert.equal(rowsOf(env, PENDING.clientId).length, 1);
  assert.equal(rowsOf(env, PENDING.clientId)[0][2], 77);
  // 재전송된 기록이 랭킹에 나타난다
  await env.fr.click('#btn-view-ranking');
  await wait(env.fr, () => /보관/.test(document.getElementById('ranking-view-list').textContent));
  await env.page.keyboard.press('Escape');

  // 응답이 유실되는 경우: 서버는 저장했지만 클라이언트는 실패로 알고 보관분을 지킨다 -> 다음 접속의 재전송은 멱등
  const second = { ...PENDING, clientId: 'zyxwvutsrqponmlk9876', score: 88 };
  await env.fr.evaluate(([k, v]) => localStorage.setItem(k, v), [STORAGE_KEYS.pending, JSON.stringify(second)]);
  ctl.queue('apiSubmit', 'lost');
  await gotoGame(env, { reload: true });
  await until(() => ctl.callsOf('apiSubmit').length === 2 && ctl.callsOf('apiSubmit')[1].outcome === 'failure', '유실된 재전송');
  await env.page.waitForTimeout(150);
  assert.equal(JSON.parse(await lsGet(env.fr, STORAGE_KEYS.pending)).score, 88, '재시도 가능한 실패인데 보관분이 사라짐');
  assert.equal(rowsOf(env, second.clientId).length, 1, '서버는 이미 저장했다');
  await gotoGame(env, { reload: true });
  await until(() => ctl.callsOf('apiSubmit').length === 3 && ctl.callsOf('apiSubmit')[2].outcome === 'success', '두 번째 재전송');
  await env.fr.waitForFunction((k) => localStorage.getItem(k) === null, STORAGE_KEYS.pending);
  assert.equal(rowsOf(env, second.clientId).length, 1, '재전송이 중복 줄을 만들었다');
  assert.deepEqual(ctl.callsOf('apiSubmit')[2].result, { ok: true });

  // 영구 오류(개연성 없음)는 더 보내 봐야 소용없으니 지운다
  const bad = { ...PENDING, clientId: 'badbadbadbadbadbad12', score: 99999, drops: 1 };
  await env.fr.evaluate(([k, v]) => localStorage.setItem(k, v), [STORAGE_KEYS.pending, JSON.stringify(bad)]);
  await gotoGame(env, { reload: true });
  await until(() => ctl.callsOf('apiSubmit').length === 4, '세 번째 재전송');
  await env.fr.waitForFunction((k) => localStorage.getItem(k) === null, STORAGE_KEYS.pending);
  assert.equal(ctl.callsOf('apiSubmit')[3].result.error, 'implausible');
  assert.equal(rowsOf(env, bad.clientId).length, 0);
});

scenario('timeout', '타임아웃: 응답이 없으면 8초 뒤 안내 + 다시 시도, 늦게 온 응답은 무시되고 재시도는 중복 줄을 만들지 않는다', {
  modes: ['same'],
}, async (env) => {
  const { fr, ctl } = env;
  const base = sheetRows(env).length;
  await playAndMerge(env);
  ctl.queue('apiRanking', 'hang');
  await gameOver(env); // 랭킹 조회가 먹통
  await fr.fill('#input-nickname', '느림');
  ctl.queue('apiSubmit', 'hang');
  const t0 = Date.now();
  await fr.click('#btn-submit');
  await waitText(fr, 'submit-status', /서버 응답이 늦어요/, 15000);
  const took = Date.now() - t0;
  assert.ok(took >= 7500 && took < 12000, `타임아웃이 ${took}ms 만에 일어남 (기본 8초여야 함)`);
  await waitText(fr, 'ranking-status', /불러오지 못했어요/, 5000);
  assert.ok(await fr.locator('#btn-submit').isEnabled());
  assert.equal(await text(fr, '#btn-submit'), '다시 시도');
  assert.equal(JSON.parse(await lsGet(fr, STORAGE_KEYS.pending)).nickname, '느림');
  assert.equal(sheetRows(env).length, base, '서버는 아직 처리하지 않았다');
  assert.equal(ctl.calls.filter((c) => c.outcome === null).length, 2);

  // 이제 늦은 응답이 도착한다: 서버는 그제서야 처리하고 두 응답 모두 이미 포기한 호출로 무시되어야 한다
  ctl.releaseHung();
  await until(() => ctl.calls.every((c) => c.outcome), '늦은 응답 도착');
  await env.page.waitForTimeout(250);
  assert.equal(sheetRows(env).length, base + 1, '늦게 처리된 제출');
  assert.match(await submitStatus(fr), /서버 응답이 늦어요/, '늦은 응답이 상태 문구를 바꿈');
  assert.equal(await text(fr, '#btn-submit'), '다시 시도');
  assert.ok(await fr.locator('#btn-submit').isEnabled());
  assert.equal(await fr.locator('#ranking-list > li').count(), 0, '늦은 랭킹 응답이 목록을 그렸다');
  assert.match(await text(fr, '#ranking-status'), /불러오지 못했어요/);

  // 재시도: 이미 저장된 기록이라 성공으로 처리되고 줄은 늘지 않는다
  await fr.click('#btn-submit');
  await wait(fr, () => document.getElementById('btn-submit').textContent === '등록 완료');
  assert.equal(sheetRows(env).length, base + 1, '재시도가 중복 줄을 만들었다');
  assert.equal(await lsGet(fr, STORAGE_KEYS.pending), null);
  await wait(fr, () => document.querySelectorAll('#ranking-list > li').length === 6);
});

scenario('offline', 'google 이 없고 API_URL 도 없으면 오프라인 모드: 안내 문구, 제출 폼 숨김, 서버 호출/보관 없음, 그래도 플레이된다', { noGoogle: true }, async (env) => {
  const { fr, ctl } = env;
  assert.equal(await fr.evaluate(() => typeof window.google), 'undefined');
  await fr.click('#btn-view-ranking');
  await waitText(fr, 'ranking-view-status', /오프라인|연결되지/);
  assert.equal(await fr.locator('#ranking-view-list > li').count(), 0);
  await fr.click('#btn-close-ranking');
  await playAndMerge(env);
  await gameOver(env);
  assert.ok(!(await isVisible(fr, '#submit-form')), '제출 폼이 숨겨져야 함');
  assert.match(await text(fr, '#ranking-status'), /오프라인|연결되지/);
  assert.match(await text(fr, '#final-score'), new RegExp(String(scoreOf(3))));
  if (env.sameOrigin) assert.equal(await lsGet(fr, STORAGE_KEYS.pending), null);
  assert.equal(ctl.calls.length, 0);
  assert.equal(sheetRows(env).length, 5);
  assert.deepEqual(env.dep.hits.map((h) => h.path), [EXEC_PATH, PANEL_PATH]);
});

scenario('offline-pending', '전송 통로가 없는 부팅(google 없음, API_URL 없음): 보관된 점수는 보내지도 지우지도 않고 그대로 둔다 (통로가 돌아온 뒤 다음 접속에서 보낼 수 있게)', {
  noGoogle: true, modes: ['same'], pending: PENDING,
}, async (env) => {
  const { fr, ctl } = env;
  assert.equal(await fr.evaluate(() => typeof window.google), 'undefined');
  // 부팅 때의 재전송 판단은 비동기이므로, 지워진다면 지워질 시간을 충분히 준다
  await env.page.waitForTimeout(500);
  assert.deepEqual(JSON.parse(await lsGet(fr, STORAGE_KEYS.pending)), PENDING, '통로가 없다는 이유로 보관된 점수를 지우면 안 된다');
  assert.equal(ctl.calls.length, 0);
  // 오프라인 모드로 정상 동작한다 (제출 폼 숨김). 게임을 해도 보관분은 그대로다.
  await playAndMerge(env);
  await gameOver(env);
  assert.ok(!(await isVisible(fr, '#submit-form')), '제출 폼이 숨겨져야 함');
  assert.deepEqual(JSON.parse(await lsGet(fr, STORAGE_KEYS.pending)), PENDING);
  assert.equal(ctl.calls.length, 0);
  assert.equal(sheetRows(env).length, 5);
});

scenario('late-google', 'google.script.run 이 로드 뒤에 생겨도 (통로는 호출 시점에 고른다) 그때부터 서버 통로를 쓴다: 오프라인 -> 랭킹/등록 가능', { noGoogle: true }, async (env) => {
  const { fr, ctl } = env;
  await fr.click('#btn-view-ranking');
  await waitText(fr, 'ranking-view-status', /오프라인|연결되지/);
  await fr.click('#btn-close-ranking');
  assert.equal(ctl.calls.length, 0);
  await fr.evaluate(installGoogleStub, { names: ctl.names }); // 이제 google.script.run 이 생겼다
  await fr.click('#btn-view-ranking');
  await wait(fr, () => document.querySelectorAll('#ranking-view-list > li').length === 5);
  assert.equal(ctl.callsOf('apiRanking').length, 1);
  await fr.click('#btn-close-ranking');
  await playAndMerge(env);
  await gameOver(env);
  assert.ok(await isVisible(fr, '#submit-form'), '제출 폼이 보여야 함');
  await fr.fill('#input-nickname', '늦게생김');
  await fr.click('#btn-submit');
  await wait(fr, () => document.getElementById('btn-submit').textContent === '등록 완료');
  assert.equal(ctl.callsOf('apiSubmit').length, 1);
  assert.equal(sheetRows(env).length, 6);
});

scenario('fetch-only', 'google 이 없고 API_URL 만 있으면 fetch 통로: 같은 Code.gs 의 doGet/doPost 로 랭킹과 등록이 된다 (text/plain, preflight 없음)', { noGoogle: true, apiUrl: FAKE_API_URL }, async (env) => {
  const { fr, dep, ctl } = env;
  await fr.click('#btn-view-ranking');
  await wait(fr, () => document.querySelectorAll('#ranking-view-list > li').length === 5);
  assert.equal(env.fetches.length, 1);
  assert.equal(env.fetches[0].method, 'GET');
  const u = new URL(env.fetches[0].url);
  assert.equal(u.searchParams.get('action'), 'ranking');
  assert.equal(u.searchParams.get('limit'), '10');
  assert.deepEqual(dep.doGetCalls.at(-1), { action: 'ranking', limit: '10' });
  await env.page.keyboard.press('Escape');

  const base = sheetRows(env).length;
  const score = await playAndMerge(env);
  await gameOver(env);
  await fr.fill('#input-nickname', '페치');
  await fr.click('#btn-submit');
  await wait(fr, () => document.getElementById('btn-submit').textContent === '등록 완료');
  const post = env.fetches.find((f) => f.method === 'POST');
  assert.match(post.contentType, /^text\/plain;\s*charset=utf-8$/i);
  assert.equal(JSON.parse(post.body).score, score);
  assert.equal(env.preflight ?? 0, 0, 'preflight(OPTIONS)가 발생하면 안 됨');
  assert.equal(sheetRows(env).length, base + 1);
  assert.equal(sheetRows(env).at(-1).length, 7);
  assert.equal(ctl.calls.length, 0, 'google.script.run 이 없는데 호출됨');
});

scenario('google-wins', 'google.script.run 과 API_URL 이 모두 있으면 google.script.run 을 쓴다 (fetch 는 한 번도 안 나감)', { apiUrl: FAKE_API_URL }, async (env) => {
  const { fr, ctl } = env;
  await fr.click('#btn-view-ranking');
  await wait(fr, () => document.querySelectorAll('#ranking-view-list > li').length === 5);
  await env.page.keyboard.press('Escape');
  await playAndMerge(env);
  await gameOver(env);
  await fr.fill('#input-nickname', '구글');
  await fr.click('#btn-submit');
  await wait(fr, () => document.getElementById('btn-submit').textContent === '등록 완료');
  assert.deepEqual(env.fetches, [], 'API_URL 로 fetch 가 나감');
  assert.equal(ctl.callsOf('apiSubmit').length, 1);
  assert.ok(ctl.callsOf('apiRanking').length >= 2);
  assert.equal(sheetRows(env).length, 6);
});

scenario('no-debug', '운영 모습(iframe 주소에 ?debug 없음): 디버그 훅이 노출되지 않고, 이름만 비슷한 쿼리에도 노출되지 않는다. 게임은 정상 시작', { query: '' }, async (env) => {
  const { page, dep } = env; // reload 마다 iframe 의 frame 이 새로 만들어지므로 env.fr 을 매번 읽는다
  const hook = () => env.fr.evaluate(() => typeof window.__fruit);
  assert.equal(await hook(), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.__fruit), 'undefined');
  assert.equal(await env.fr.evaluate(() => location.search), '');
  for (const q of ['?nodebug=1', '?utm_campaign=debug-day', '?debugger']) {
    dep.iframeQuery = q;
    await gotoGame(env, { debug: false, reload: true });
    assert.equal(await hook(), 'undefined', `${q} 에서 디버그 훅이 노출됨`);
  }
  dep.iframeQuery = '';
  await gotoGame(env, { debug: false, reload: true });
  await env.fr.click('#btn-start');
  await env.fr.waitForFunction(() => document.getElementById('screen-start').hidden);
  const p = await worldToClient(env, 200);
  await env.page.mouse.click(p.x, p.y);
  await env.page.waitForTimeout(100);
  assert.equal(await hook(), 'undefined');
  assert.ok(!(await isVisible(env.fr, '#screen-gameover')));
  // 쿼리에 ?debug 를 붙이면 (테스트 전용) 그제서야 생긴다
  dep.iframeQuery = '?x=1&debug=1';
  await gotoGame(env, { debug: true, reload: true });
});

scenario('storage-blocked', 'localStorage 가 막힌 iframe(allow-same-origin 없음): SecurityError 인데도 게임이 돌고 최고점/닉네임이 메모리에 유지되며 오류가 없다', { modes: ['opaque'] }, async (env) => {
  const { fr, ctl } = env;
  assert.equal(await lsState(fr), 'SecurityError');
  assert.equal(await fr.evaluate(() => { try { return typeof localStorage; } catch (e) { return e.name; } }), 'SecurityError');
  assert.equal(await fr.evaluate(() => { try { sessionStorage.setItem('a', 'b'); return 'ok'; } catch (e) { return e.name; } }), 'SecurityError');
  const score = await playAndMerge(env);
  await gameOver(env);
  assert.equal(await text(fr, '#best'), String(score), '최고점이 메모리에 유지돼야 함');
  await fr.fill('#input-nickname', '메모리');
  ctl.queue('apiSubmit', 'fail');
  await fr.click('#btn-submit');
  await waitText(fr, 'submit-status', /네트워크/);
  await fr.click('#btn-submit'); // 보관분은 메모리에 있어도 재시도는 같은 clientId 로 나간다
  await wait(fr, () => document.getElementById('btn-submit').textContent === '등록 완료');
  const submits = ctl.callsOf('apiSubmit');
  assert.equal(submits.length, 2);
  assert.equal(submits[0].args[0].clientId, submits[1].args[0].clientId, '저장소가 막혀도 같은 판은 같은 clientId 로 보낸다');
  assert.match(submits[0].args[0].clientId, CLIENT_ID_RE);
  assert.equal(sheetRows(env).length, 6);
  // 다음 판: 닉네임이 기억되어 있다
  await restartGame(env);
  await pause(fr);
  await gameOver(env);
  assert.equal(await fr.inputValue('#input-nickname'), '메모리');
  assert.equal(await text(fr, '#final-best'), String(score));
});

scenario('exec-routing', '웹 앱 주소 라우팅: 주소만 열면 화면, ?action=ranking 은 JSON, 알 수 없는 action 은 bad_request, POST 는 JSON, Index 가 없으면 친절한 안내', {
  noPage: true, rows: sampleSheet(5), modes: ['same'],
}, async (env) => {
  const { dep } = env;
  const get = async (q = '') => {
    const res = await fetch(dep.url + q);
    return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
  };
  for (const q of ['', '?', '?action=', '?foo=bar', '?debug']) {
    const r = await get(q);
    assert.equal(r.status, 200);
    assert.match(r.type, /^text\/html/, `${q || '(없음)'} 은 화면이어야 함`);
    assert.match(r.body, /<title>수박 합치기<\/title>/);
    assert.match(r.body, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
    assert.match(r.body, /<iframe[^>]+sandbox="allow-scripts /);
  }
  const ranking = await get('?action=ranking&limit=3');
  assert.match(ranking.type, /^application\/json/);
  const json = JSON.parse(ranking.body);
  assert.equal(json.ok, true);
  assert.equal(json.data.length, 3);
  assert.deepEqual(Object.keys(json.data[0]).sort(), ['at', 'maxLevel', 'nickname', 'score']);
  assert.deepEqual(JSON.parse((await get('?action=bogus')).body), { ok: false, error: 'bad_request' });
  assert.deepEqual(JSON.parse((await get('?action=ranking%20')).body), { ok: false, error: 'bad_request' });
  assert.deepEqual(JSON.parse((await get('?action=0')).body), { ok: false, error: 'bad_request' }, '문자열 "0" 도 action 이다');
  const body = { nickname: '외부', score: 10, maxLevel: 2, playTimeMs: 5000, drops: 5, clientId: 'externalclient00001' };
  const post = await fetch(dep.url, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  assert.deepEqual(await post.json(), { ok: true });
  const sheet = sheetRows(env).at(-1);
  assert.equal(sheet.length, 7);
  assert.equal(sheet[1], '외부');
  const bad = await fetch(dep.url, { method: 'POST', body: '<html>' });
  assert.deepEqual(await bad.json(), { ok: false, error: 'bad_request' });
  assert.ok(dep.doGetCalls.some((p) => p.action === undefined && p.foo === 'bar'));

  // Index.html 을 안 올린 배포: 스택 트레이스 없이 무엇을 해야 하는지 알려 준다
  const missing = await startDeployment({ withIndex: false });
  try {
    const res = await fetch(missing.url);
    const t = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.match(t, /Index\.html/);
    assert.match(t, /배포/);
    assert.ok(!/Error|at \w+|\.gs:\d|stack|Unknown file/i.test(t), `스택/내부 오류가 노출됨: ${t}`);
    assert.ok(!t.includes('<'), '안내 문구에 HTML 이 섞임');
    assert.ok(missing.mocks.errors.some((e) => /Index/.test(e)), '원인은 실행 로그에 남는다');
    // 그래도 JSON API 는 동작한다
    const api = await (await fetch(missing.url + '?action=ranking')).json();
    assert.equal(api.ok, true);
  } finally {
    await missing.close();
  }
});

// 스크린샷 (--shots=폴더 일 때만). 상태마다 새 페이지에서 찍고 찍은 뒤에는 아무것도 누르지 않는다:
// 모바일 에뮬레이션에서 page.screenshot 뒤에는 (다른 origin 의) iframe 안으로 보내는 터치/rAF 대기가 먹통이 되는 Playwright 쪽 문제가 있다.
const SHOT_VIEWPORTS = [
  { id: '390x844', viewport: { width: 390, height: 844 }, mobile: true },
  { id: '1280x720', viewport: { width: 1280, height: 720 }, mobile: false },
];
const SHOT_STATES = {
  '1-start': async () => {},
  '2-ranking': async (env) => {
    await tapOrClick(env, '#btn-view-ranking');
    await wait(env.fr, () => document.querySelectorAll('#ranking-view-list > li').length === 9);
  },
  '3-playing': async (env) => {
    const { fr } = env;
    await startGame(env);
    await mouseDrop(env, 120);
    await pause(fr);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 16; i++) {
      const lvl = Math.floor(rnd() * 4);
      const r = FRUITS[lvl].radius;
      await spawn(fr, lvl, r + rnd() * (WORLD.width - 2 * r), 140);
      await advance(fr, 330);
    }
    await advance(fr, 1500);
  },
  '4-gameover': async (env) => {
    const { fr } = env;
    await playAndMerge(env);
    await gameOver(env);
    await fr.fill('#input-nickname', '스크린샷');
    await wait(fr, () => document.querySelectorAll('#ranking-list > li').length === 9);
    await tapOrClick(env, '#btn-submit');
    await wait(fr, () => document.querySelectorAll('#ranking-list > li').length === 10 && /스크린샷/.test(document.getElementById('ranking-list').textContent));
  },
};
for (const v of SHOT_VIEWPORTS) {
  for (const [state, setup] of Object.entries(SHOT_STATES)) {
    scenario(`shots-${v.id}-${state}`, `스크린샷 ${v.id} ${state} (iframe 안 화면)`, { viewport: v.viewport, mobile: v.mobile, modes: ['same'], rows: sampleSheet(9), shots: true }, async (env) => {
      env.mobile = v.mobile;
      await setup(env);
      await env.page.waitForTimeout(500); // 오버레이 페이드 인이 끝난 뒤에 찍는다
      await env.page.screenshot({ path: path.join(env.shotsDir, `${v.id}-${state}.png`) });
    });
  }
}

// ───────────────────────── 실행 ─────────────────────────

export function expand(list, { shots = false } = {}) {
  const out = [];
  for (const sc of list) {
    if (!!sc.opts.shots !== shots) continue;
    for (const mode of MODES) {
      if (sc.opts.modes && !sc.opts.modes.includes(mode.id)) continue;
      out.push({ ...sc, key: sc.opts.modes?.length === 1 ? sc.id : `${sc.id}@${mode.id}`, mode });
    }
  }
  return out;
}

export async function runScenario(browser, sc, extra = {}) {
  const { noPage, modes, shots, ...openOpts } = sc.opts;
  let env = null;
  let error = null;
  try {
    env = await openGas(browser, { ...openOpts, sameOrigin: sc.mode.sameOrigin, load: !noPage });
    env.mode = sc.mode;
    env.mobile = !!openOpts.mobile;
    env.shotsDir = extra.shotsDir;
    await sc.fn(env);
  } catch (e) {
    error = e; // 준비 단계 실패도 한 시나리오의 FAIL 로 보고하고 나머지는 계속 돌린다
  }
  const issues = env ? remainingIssues(env) : [];
  await env?.ctx.close().catch(() => {});
  await env?.dep.close();
  return { error, issues };
}

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice(7).split(',') : null;
  const shotsArg = process.argv.find((a) => a.startsWith('--shots='));
  const shotsDir = shotsArg ? path.resolve(shotsArg.slice(8)) : null;
  if (shotsDir) await fs.mkdir(shotsDir, { recursive: true });
  const todo = expand(scenarios, { shots: !!shotsDir }).filter((s) => !only || only.includes(s.id) || only.includes(s.key));
  const bail = process.argv.includes('--bail'); // 첫 실패에서 멈춘다 (변이 검사용)
  const browser = await launchBrowser();
  let failed = 0;
  let done = 0;
  const t0 = Date.now();
  try {
    for (const sc of todo) {
      const t = Date.now();
      const { error, issues } = await runScenario(browser, sc, { shotsDir });
      const ok = !error && issues.length === 0;
      if (!ok) failed += 1;
      done += 1;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.key.padEnd(20)} ${sc.title} (${Date.now() - t}ms)`);
      if (error) console.log(`       ${String(error.stack || error).split('\n').slice(0, 8).join('\n       ')}`);
      for (const i of issues) console.log(`       [${i.kind}] ${i.text}`);
      if (!ok && bail) break;
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${done - failed}/${bail ? done : todo.length} scenarios passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exitCode = failed || !todo.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
