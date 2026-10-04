// Apps Script 랭킹 API 클라이언트. 어떤 경우에도 throw/reject 하지 않고 { ok, ... } 로 돌려준다.
// GAS 웹 앱은 CORS preflight(OPTIONS)에 답하지 못하므로 POST 는 text/plain + 커스텀 헤더 없음으로 보낸다.
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

// 제어문자와 눈에 안 보이는 서식 문자 (서버의 NICKNAME_STRIP_RE 와 같은 범위)
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\u3164\uffa0\ufeff]/g;

function resolveUrl(opts) {
  const url = opts && opts.url !== undefined ? opts.url : API_URL;
  return typeof url === 'string' ? url.trim() : '';
}

export function isApiConfigured(opts) {
  return resolveUrl(opts) !== '';
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

  const timeoutMs = opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : TIMEOUT_MS;
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
  if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
    return { ok: false, error: 'bad_response' };
  }
  if (!body.ok) {
    const error = SERVER_ERRORS.has(body.error) ? body.error : 'bad_response';
    return { ok: false, error };
  }
  if (!got.httpOk) return { ok: false, error: 'bad_response' };
  return { ok: true, body };
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
    const base = resolveUrl(opts);
    if (!base) return { ok: false, error: 'not_configured' };
    const n = Math.floor(Number(limit));
    const safeLimit = Number.isFinite(n) && n >= 1 ? Math.min(n, RANKING_MAX) : RANKING_LIMIT;
    const url = buildUrl(base, { action: 'ranking', limit: safeLimit });

    const res = await request(url, { method: 'GET' }, opts);
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
    const base = resolveUrl(opts);
    if (!base) return { ok: false, error: 'not_configured' };
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'bad_request' };

    const { nickname, score, maxLevel, playTimeMs, drops, clientId } = payload;
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // preflight 회피: 이 헤더만 보낸다
      body: JSON.stringify({ nickname, score, maxLevel, playTimeMs, drops, clientId }),
    };
    const res = await request(base, init, opts);
    return res.ok ? { ok: true } : res;
  } catch (err) {
    return { ok: false, error: 'network' };
  }
}
