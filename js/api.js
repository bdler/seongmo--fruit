// Apps Script 랭킹 API 클라이언트. 어떤 경우에도 throw/reject 하지 않고 { ok, ... } 로 돌려준다.
//
// 통로(transport)는 호출할 때마다 이 순서로 고른다 (import 시점이 아니다):
//   1) 테스트용 명시 값: opts.gasRun (google.script.run 대용) -> opts.url (fetch 용 주소)
//   2) window.google.script.run  — Apps Script 웹 앱이 직접 내보낸 게임 화면 안. 서버의 apiRanking / apiSubmit 을 부른다.
//   3) fetch(API_URL)            — GitHub Pages 등 따로 호스팅할 때. GAS 웹 앱은 CORS preflight(OPTIONS)에 답하지 못하므로
//                                  POST 는 text/plain + 커스텀 헤더 없음으로 보낸다.
//   4) 아무것도 없으면 { ok: false, error: 'not_configured' }
// 어느 통로든 결과 계약은 같다: 서버 에러 코드는 그대로, 통로 실패는 'network'/'timeout', 이상한 응답은 'bad_response'.
import { API_URL, RANKING_LIMIT, LAST_LEVEL } from './config.js';

const TIMEOUT_MS = 8000;
const RANKING_MAX = 50; // 서버의 RANKING_KEEP 과 같다

// 서버가 돌려줄 수 있는 에러 코드. 그 밖의 값은 알 수 없는 응답으로 취급한다.
const SERVER_ERRORS = new Set([
  'bad_request',
  'invalid_nickname',
  'invalid_score',
  'implausible',
  'throttled',
  'server_busy',
]);

// 제어문자와 눈에 안 보이는 서식 문자 (서버의 NICKNAME_STRIP_RE / NICKNAME_NO_VISIBLE_RE 와 같은 범위)
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u2800\u3164\uffa0\ufeff]/g;
const NO_VISIBLE_RE = /^[\s\ufe00-\ufe0f\u{e0000}-\u{e0fff}]*$/u;

function resolveUrl(opts) {
  const url = opts && opts.url !== undefined ? opts.url : API_URL;
  return typeof url === 'string' ? url.trim() : '';
}

// google.script.run 으로 쓸 수 있는 객체인가 (withSuccessHandler 를 가진 객체/함수)
function isRunner(run) {
  return !!run && (typeof run === 'object' || typeof run === 'function') && typeof run.withSuccessHandler === 'function';
}

function globalRunner() {
  try {
    const run = globalThis.google && globalThis.google.script && globalThis.google.script.run;
    return isRunner(run) ? run : null;
  } catch (err) {
    return null; // 접근자가 던지는 이상한 환경
  }
}

// 이번 호출이 쓸 통로를 고른다. 호출 시점의 전역/설정을 보므로 나중에 생기거나 바뀐 값도 반영된다.
//   opts.gasRun 이 주어지면(null 포함) 전역 google 은 보지 않는다. 쓸 수 없는 값/null 이면 gas 통로를 끄고 fetch 로 넘어간다.
//   opts.url 이 주어지면(빈 문자열 포함) 그것이 fetch 용 명시 값이므로 전역 google 보다 앞선다.
function selectTransport(opts) {
  if (opts && opts.gasRun !== undefined) {
    if (isRunner(opts.gasRun)) return { kind: 'gas', run: opts.gasRun };
  } else if (!(opts && opts.url !== undefined)) {
    const run = globalRunner();
    if (run) return { kind: 'gas', run };
  }
  const url = resolveUrl(opts);
  return url ? { kind: 'fetch', url } : { kind: 'none' };
}

export function isApiConfigured(opts) {
  return selectTransport(opts).kind !== 'none';
}

function buildUrl(base, params) {
  const hash = base.indexOf('#');
  if (hash >= 0) base = base.slice(0, hash); // 프래그먼트는 서버로 가지 않는다
  const query = Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const sep = base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?';
  return base + sep + query;
}

// 응답 본문을 읽어 JSON 객체로 파싱한다. 실패는 모두 { ok: false, error } 로 정규화.
async function request(url, init, opts) {
  const fetchImpl = opts && opts.fetchImpl ? opts.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'network' };

  const timeoutMs = resolveTimeout(opts);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const TIMED_OUT = Symbol('timeout');
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (ctrl) ctrl.abort();
      resolve(TIMED_OUT);
    }, timeoutMs);
  });

  // fetchImpl 이 signal 을 무시해도 멈추지 않도록 본문 읽기까지 묶어서 경주시킨다.
  const run = (async () => {
    const res = await fetchImpl(url, ctrl ? { ...init, signal: ctrl.signal } : init);
    return { text: await res.text(), httpOk: res.ok !== false };
  })();

  let got;
  try {
    got = await Promise.race([run, timeout]);
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return { ok: false, error: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
  if (got === TIMED_OUT) return { ok: false, error: 'timeout' };

  let body;
  try {
    body = JSON.parse(got.text);
  } catch (err) {
    return { ok: false, error: 'bad_response' }; // HTML 오류 페이지(로그인 요구, 404 등)
  }
  return interpretBody(body, got.httpOk);
}

// 서버가 돌려준 객체({ ok, ... })를 해석한다. fetch 와 google.script.run 이 함께 쓴다.
function interpretBody(body, httpOk = true) {
  if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
    return { ok: false, error: 'bad_response' };
  }
  if (!body.ok) {
    const error = SERVER_ERRORS.has(body.error) ? body.error : 'bad_response';
    return { ok: false, error };
  }
  if (!httpOk) return { ok: false, error: 'bad_response' };
  return { ok: true, body };
}

function resolveTimeout(opts) {
  return opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : TIMEOUT_MS;
}

// google.script.run 호출 한 번. run.withSuccessHandler(..).withFailureHandler(..).<서버 함수>(인자)
// withSuccessHandler/withFailureHandler 는 호출마다 '새' 실행기를 돌려주므로 체인을 매번 새로 만든다
// (한 실행기에 핸들러를 붙여 재사용하면 호출끼리 핸들러가 섞인다). 처음 도착한 결과만 쓰고 타임아웃 뒤의 늦은 콜백은 버린다.
function requestGas(run, fn, arg, opts) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), resolveTimeout(opts));
    try {
      run
        .withSuccessHandler((result) => {
          let res;
          try {
            res = interpretBody(result);
          } catch (err) {
            res = { ok: false, error: 'bad_response' }; // 접근자가 던지는 이상한 객체
          }
          finish(res);
        })
        .withFailureHandler(() => finish({ ok: false, error: 'network' })) // 오프라인, 서버 오류, 할당량 초과, 없는 함수 등
        [fn](arg);
    } catch (err) {
      finish({ ok: false, error: 'network' }); // 실행기가 없거나 호출 자체가 던진 경우
    }
  });
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

// 형식이 깨진 행은 null. 숫자는 정수로 맞추고 maxLevel 은 유효 범위로 제한한다.
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.nickname !== 'string') return null;
  const nickname = row.nickname.replace(INVISIBLE_RE, '').trim();
  if (NO_VISIBLE_RE.test(nickname)) return null; // 예전에 저장된 '보이지 않는 닉네임' 행이 빈 이름으로 나오지 않게
  const score = toNumber(row.score);
  const maxLevel = toNumber(row.maxLevel);
  const at = toNumber(row.at);
  if (!nickname || !Number.isFinite(score) || score < 0) return null;
  if (!Number.isFinite(maxLevel) || !Number.isFinite(at)) return null;
  return {
    nickname,
    score: Math.trunc(score),
    maxLevel: Math.min(Math.max(Math.trunc(maxLevel), 0), LAST_LEVEL),
    at: Math.trunc(at),
  };
}

export async function fetchRanking(limit = RANKING_LIMIT, opts) {
  try {
    const transport = selectTransport(opts);
    if (transport.kind === 'none') return { ok: false, error: 'not_configured' };
    const n = Math.floor(Number(limit));
    const safeLimit = Number.isFinite(n) && n >= 1 ? Math.min(n, RANKING_MAX) : RANKING_LIMIT;

    const res =
      transport.kind === 'gas'
        ? await requestGas(transport.run, 'apiRanking', safeLimit, opts)
        : await request(buildUrl(transport.url, { action: 'ranking', limit: safeLimit }), { method: 'GET' }, opts);
    if (!res.ok) return res;
    if (!Array.isArray(res.body.data)) return { ok: false, error: 'bad_response' };
    const data = res.body.data.map(normalizeRow).filter(Boolean).slice(0, safeLimit);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: 'network' };
  }
}

export async function submitScore(payload, opts) {
  try {
    const transport = selectTransport(opts);
    if (transport.kind === 'none') return { ok: false, error: 'not_configured' };
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'bad_request' };

    const { nickname, score, maxLevel, playTimeMs, drops, clientId } = payload;
    const picked = { nickname, score, maxLevel, playTimeMs, drops, clientId };
    let res;
    if (transport.kind === 'gas') {
      // google.script.run 은 JSON 으로 표현되는 값만 받는다. fetch 경로의 JSON.stringify 와 똑같이 정리해서
      // (undefined 는 빠지고 NaN 은 null 이 된다) 서버가 어느 통로로 받아도 같은 입력을 보게 한다.
      res = await requestGas(transport.run, 'apiSubmit', JSON.parse(JSON.stringify(picked)), opts);
    } else {
      const init = {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // preflight 회피: 이 헤더만 보낸다
        body: JSON.stringify(picked),
      };
      res = await request(transport.url, init, opts);
    }
    return res.ok ? { ok: true } : res;
  } catch (err) {
    return { ok: false, error: 'network' };
  }
}
