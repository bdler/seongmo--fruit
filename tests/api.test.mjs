import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RANKING_LIMIT, LAST_LEVEL } from '../js/config.js';
import { isApiConfigured, fetchRanking, submitScore } from '../js/api.js';
import { createScriptRun } from './helpers/gas-env.mjs';

const URL_BASE = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const CID = 'abcdefghijklmnop1234';

// ── 가짜 fetch ───────────────────────────────────────────

function response(body, { status = 200 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

// 호출을 기록하고 handler(url, init) 의 결과를 돌려주는 fetchImpl
function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

const replyWith = (body, opts) => recorder(() => response(body, opts));
const opts = (fetchImpl, extra = {}) => ({ url: URL_BASE, fetchImpl, ...extra });

const row = (over = {}) => ({ nickname: '수박왕', score: 500, maxLevel: 7, at: 1700000000000, ...over });

const payload = (over = {}) => ({
  nickname: '수박왕',
  score: 321,
  maxLevel: 7,
  playTimeMs: 90000,
  drops: 80,
  clientId: CID,
  ...over,
});

// ── isApiConfigured ──────────────────────────────────────

test('isApiConfigured: 빈 URL/공백/문자열이 아닌 값은 미설정', () => {
  assert.equal(isApiConfigured({ url: '' }), false);
  assert.equal(isApiConfigured({ url: '   ' }), false);
  assert.equal(isApiConfigured({ url: null }), false);
  assert.equal(isApiConfigured({ url: 42 }), false);
  assert.equal(isApiConfigured({ url: URL_BASE }), true);
});

test('isApiConfigured: 인자 없이 config.js 의 API_URL 을 본다', async () => {
  const { API_URL } = await import('../js/config.js');
  assert.equal(isApiConfigured(), API_URL.trim() !== '');
});

test('미설정이면 네트워크를 호출하지 않고 not_configured', async () => {
  const { calls, fetchImpl } = replyWith({ ok: true, data: [] });
  const o = { url: '', fetchImpl };
  assert.deepEqual(await fetchRanking(10, o), { ok: false, error: 'not_configured' });
  assert.deepEqual(await submitScore(payload(), o), { ok: false, error: 'not_configured' });
  assert.equal(calls.length, 0);
});

// ── fetchRanking ─────────────────────────────────────────

test('fetchRanking: GET 으로 요청하고 행을 돌려준다 (헤더 없음)', async () => {
  const { calls, fetchImpl } = replyWith({ ok: true, data: [row(), row({ nickname: 'b', score: 400 })] });
  const res = await fetchRanking(10, opts(fetchImpl));

  assert.deepEqual(res, {
    ok: true,
    data: [
      { nickname: '수박왕', score: 500, maxLevel: 7, at: 1700000000000 },
      { nickname: 'b', score: 400, maxLevel: 7, at: 1700000000000 },
    ],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${URL_BASE}?action=ranking&limit=10`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers, undefined, 'GET 은 어떤 헤더도 붙이지 않는다');
  assert.equal(calls[0].init.body, undefined);
  assert.ok(calls[0].init.signal, '타임아웃용 AbortSignal 이 있다');
});

test('fetchRanking: 기본 limit 은 RANKING_LIMIT', async () => {
  const { calls, fetchImpl } = replyWith({ ok: true, data: [] });
  assert.deepEqual(await fetchRanking(undefined, opts(fetchImpl)), { ok: true, data: [] });
  assert.equal(calls[0].url, `${URL_BASE}?action=ranking&limit=${RANKING_LIMIT}`);
});

test('fetchRanking: limit 보정 (정수화, 1..50, 잘못된 값은 기본값)', async () => {
  const limitOf = async (limit) => {
    const { calls, fetchImpl } = replyWith({ ok: true, data: [] });
    await fetchRanking(limit, opts(fetchImpl));
    return new URL(calls[0].url).searchParams.get('limit');
  };
  assert.equal(await limitOf(5), '5');
  assert.equal(await limitOf(5.9), '5');
  assert.equal(await limitOf('7'), '7');
  assert.equal(await limitOf(1), '1');
  assert.equal(await limitOf(50), '50');
  assert.equal(await limitOf(999), '50');
  assert.equal(await limitOf(0), String(RANKING_LIMIT));
  assert.equal(await limitOf(-3), String(RANKING_LIMIT));
  assert.equal(await limitOf(NaN), String(RANKING_LIMIT));
  assert.equal(await limitOf('abc'), String(RANKING_LIMIT));
  assert.equal(await limitOf(null), String(RANKING_LIMIT));
});

test('fetchRanking: URL 에 이미 쿼리가 있어도 안전하게 이어 붙인다', async () => {
  const urlFor = async (base) => {
    const { calls, fetchImpl } = replyWith({ ok: true, data: [] });
    await fetchRanking(3, { url: base, fetchImpl });
    return calls[0].url;
  };
  assert.equal(await urlFor(URL_BASE), `${URL_BASE}?action=ranking&limit=3`);
  assert.equal(await urlFor(`${URL_BASE}?authuser=1`), `${URL_BASE}?authuser=1&action=ranking&limit=3`);
  assert.equal(await urlFor(`${URL_BASE}?`), `${URL_BASE}?action=ranking&limit=3`);
  assert.equal(await urlFor(`${URL_BASE}?authuser=1&`), `${URL_BASE}?authuser=1&action=ranking&limit=3`);
  assert.equal(await urlFor(`  ${URL_BASE}  `), `${URL_BASE}?action=ranking&limit=3`, '앞뒤 공백 제거');
  assert.equal(await urlFor(`${URL_BASE}#frag`), `${URL_BASE}?action=ranking&limit=3`, '프래그먼트는 서버로 가지 않는다');
  assert.equal(await urlFor(`${URL_BASE}?a=b%20c&d=é#x`), `${URL_BASE}?a=b%20c&d=é&action=ranking&limit=3`, '기존 쿼리는 건드리지 않는다');
  // 상대 경로(개발용 프록시)도 허용
  assert.equal(await urlFor('/api/exec'), '/api/exec?action=ranking&limit=3');
});

test('fetchRanking: 서버가 limit 보다 많이 돌려줘도 잘라낸다', async () => {
  const data = Array.from({ length: 8 }, (_, i) => row({ nickname: 'p' + i, score: 100 - i }));
  const res = await fetchRanking(3, opts(replyWith({ ok: true, data }).fetchImpl));
  assert.deepEqual(res.data.map((r) => r.nickname), ['p0', 'p1', 'p2']);
});

test('fetchRanking: 형식이 깨진 행은 버리고 숫자는 정수로 맞춘다', async () => {
  const data = [
    row({ nickname: 'ok1' }),
    null,
    'string',
    42,
    [],
    {},
    row({ nickname: undefined }),
    row({ nickname: 123 }),
    row({ nickname: '' }),
    row({ nickname: '   ' }),
    row({ nickname: '\u200b\u202e' }),
    row({ nickname: 'noScore', score: undefined }),
    row({ nickname: 'nullScore', score: null }),
    row({ nickname: 'textScore', score: 'abc' }),
    row({ nickname: 'emptyScore', score: '' }),
    row({ nickname: 'nanScore', score: NaN }), // JSON 에서는 null 이 된다
    row({ nickname: 'negScore', score: -1 }),
    row({ nickname: 'noLevel', maxLevel: undefined }),
    row({ nickname: 'badLevel', maxLevel: 'x' }),
    row({ nickname: 'noAt', at: undefined }),
    row({ nickname: 'badAt', at: 'yesterday' }),
    row({ nickname: 'ok2', score: '321', maxLevel: '4', at: '1700000000123' }), // 숫자 문자열은 받는다
    row({ nickname: 'ok3', score: 12.9, maxLevel: 3.7, at: 99.5 }), // 소수는 정수로
    row({ nickname: 'ok4', maxLevel: 99 }), // 범위 밖은 보정
    row({ nickname: 'ok5', maxLevel: -4 }),
  ];
  const res = await fetchRanking(50, opts(replyWith({ ok: true, data }).fetchImpl));
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.data,
    [
      { nickname: 'ok1', score: 500, maxLevel: 7, at: 1700000000000 },
      { nickname: 'ok2', score: 321, maxLevel: 4, at: 1700000000123 },
      { nickname: 'ok3', score: 12, maxLevel: 3, at: 99 },
      { nickname: 'ok4', score: 500, maxLevel: LAST_LEVEL, at: 1700000000000 },
      { nickname: 'ok5', score: 500, maxLevel: 0, at: 1700000000000 },
    ]
  );
});

test('fetchRanking: 보이는 글자가 없는 닉네임(한글 채움 문자, 점자 빈칸 등)의 행은 버린다', async () => {
  const blank = ['\u115f', '\u1160', '\u115f\u1160', '\u2800', '\u061c', '\u034f', '\u180e', '\u17b4\u17b5', '\ufe0f', ' \ufe0e\ufe0f ', '\u{e0041}'];
  const data = [...blank.map((nickname) => row({ nickname })), row({ nickname: '수\u115f박\u2800' }), row({ nickname: '\u2764\ufe0f' }), row({ nickname: '^^' })];
  const res = await fetchRanking(50, opts(replyWith({ ok: true, data }).fetchImpl));
  assert.deepEqual(res.data.map((r) => r.nickname), ['수박', '\u2764\ufe0f', '^^']);
});

test('fetchRanking: 닉네임의 제어문자/보이지 않는 문자는 지우되 HTML 은 그대로 둔다 (표시는 textContent)', async () => {
  const data = [row({ nickname: '  a\u0000b\u0007\u202ec  ' }), row({ nickname: '<img src=x onerror=alert(1)>' })];
  const res = await fetchRanking(10, opts(replyWith({ ok: true, data }).fetchImpl));
  assert.deepEqual(res.data.map((r) => r.nickname), ['abc', '<img src=x onerror=alert(1)>']);
});

test('fetchRanking: data 가 배열이 아니면 bad_response', async () => {
  for (const body of [{ ok: true }, { ok: true, data: null }, { ok: true, data: {} }, { ok: true, data: 'x' }]) {
    const res = await fetchRanking(10, opts(replyWith(body).fetchImpl));
    assert.deepEqual(res, { ok: false, error: 'bad_response' }, JSON.stringify(body));
  }
});

// ── submitScore ──────────────────────────────────────────

test('submitScore: POST text/plain, 헤더는 Content-Type 하나뿐 (preflight 회피)', async () => {
  const { calls, fetchImpl } = replyWith({ ok: true });
  const res = await submitScore(payload(), opts(fetchImpl));
  assert.deepEqual(res, { ok: true });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, URL_BASE, 'POST 는 URL 에 쿼리를 붙이지 않는다');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
  assert.deepEqual(JSON.parse(init.body), payload());

  // CORS 단순 요청 조건: 안전 목록 Content-Type 하나, 커스텀 헤더/자격 증명/모드 변경 없음
  assert.match(init.headers['Content-Type'], /^text\/plain(;|$)/i);
  assert.doesNotMatch(JSON.stringify(init.headers), /json|authorization|x-/i);
  assert.deepEqual(Object.keys(init.headers), ['Content-Type']);
  for (const key of Object.keys(init)) assert.ok(['method', 'headers', 'body', 'signal'].includes(key), `예상 밖 옵션: ${key}`);
});

test('submitScore: 계약된 필드만 보내고 clientId 가 없으면 생략한다', async () => {
  const { calls, fetchImpl } = replyWith({ ok: true });
  await submitScore({ ...payload(), clientId: undefined, extra: 'x' }, opts(fetchImpl));
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(sent).sort(), ['drops', 'maxLevel', 'nickname', 'playTimeMs', 'score']);
});

test('submitScore: 서버 에러 코드는 그대로 전달한다', async () => {
  for (const error of ['bad_request', 'invalid_nickname', 'invalid_score', 'implausible', 'throttled', 'server_busy']) {
    const res = await submitScore(payload(), opts(replyWith({ ok: false, error }).fetchImpl));
    assert.deepEqual(res, { ok: false, error }, error);
  }
});

test('submitScore: 모르는 에러 코드나 error 없는 실패는 bad_response', async () => {
  for (const body of [{ ok: false }, { ok: false, error: 'boom' }, { ok: false, error: 42 }, { ok: false, error: { a: 1 } }]) {
    const res = await submitScore(payload(), opts(replyWith(body).fetchImpl));
    assert.deepEqual(res, { ok: false, error: 'bad_response' }, JSON.stringify(body));
  }
});

test('submitScore: 객체가 아닌 payload 는 네트워크 없이 bad_request', async () => {
  const { calls, fetchImpl } = replyWith({ ok: true });
  for (const bad of [null, undefined, 'x', 42]) {
    assert.deepEqual(await submitScore(bad, opts(fetchImpl)), { ok: false, error: 'bad_request' });
  }
  assert.equal(calls.length, 0);
});

// ── 실패 정규화 (두 함수 공통) ────────────────────────────

const callers = {
  fetchRanking: (o) => fetchRanking(10, o),
  submitScore: (o) => submitScore(payload(), o),
};

for (const [name, call] of Object.entries(callers)) {
  test(`${name}: fetch 거부(오프라인/CORS)는 network`, async () => {
    const fetchImpl = async () => {
      throw new TypeError('Failed to fetch');
    };
    assert.deepEqual(await call(opts(fetchImpl)), { ok: false, error: 'network' });
  });

  test(`${name}: fetchImpl 이 동기적으로 던지거나 이상한 값을 던져도 network`, async () => {
    assert.deepEqual(
      await call(
        opts(() => {
          throw new Error('sync boom');
        })
      ),
      { ok: false, error: 'network' }
    );
    assert.deepEqual(await call(opts(async () => Promise.reject('just a string'))), { ok: false, error: 'network' });
    assert.deepEqual(await call(opts(async () => Promise.reject(undefined))), { ok: false, error: 'network' });
  });

  test(`${name}: fetchImpl 이 함수가 아니면 network`, async () => {
    assert.deepEqual(await call({ url: URL_BASE, fetchImpl: 'nope' }), { ok: false, error: 'network' });
  });

  test(`${name}: 응답 본문을 읽다 실패하면 network`, async () => {
    const fetchImpl = async () => ({
      ok: true,
      text: async () => {
        throw new TypeError('network error while reading body');
      },
    });
    assert.deepEqual(await call(opts(fetchImpl)), { ok: false, error: 'network' });
  });

  test(`${name}: JSON 이 아닌 응답(HTML 등)은 bad_response`, async () => {
    const html = '<!DOCTYPE html><html><body>Sign in - Google Accounts</body></html>';
    for (const body of [html, '', '   ', '{oops', 'undefined']) {
      assert.deepEqual(await call(opts(replyWith(body).fetchImpl)), { ok: false, error: 'bad_response' }, JSON.stringify(body));
    }
    // 오류 상태 코드의 HTML 페이지
    assert.deepEqual(await call(opts(replyWith(html, { status: 404 }).fetchImpl)), { ok: false, error: 'bad_response' });
    assert.deepEqual(await call(opts(replyWith(html, { status: 500 }).fetchImpl)), { ok: false, error: 'bad_response' });
  });

  test(`${name}: JSON 이어도 { ok: boolean } 모양이 아니면 bad_response`, async () => {
    for (const body of ['[]', 'null', '"text"', '123', 'true', '{}', '{"ok":"yes"}', '{"ok":1}', '{"data":[]}']) {
      assert.deepEqual(await call(opts(replyWith(body).fetchImpl)), { ok: false, error: 'bad_response' }, body);
    }
  });

  test(`${name}: HTTP 오류 상태인데 성공 JSON 이면 신뢰하지 않는다`, async () => {
    const res = await call(opts(replyWith({ ok: true, data: [] }, { status: 500 }).fetchImpl));
    assert.deepEqual(res, { ok: false, error: 'bad_response' });
  });

  test(`${name}: 타임아웃(signal 을 따르는 fetch)은 timeout 이고 요청을 abort 한다`, async () => {
    let signal;
    const fetchImpl = (url, init) =>
      new Promise((resolve, reject) => {
        signal = init.signal;
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const res = await call(opts(fetchImpl, { timeoutMs: 20 }));
    assert.deepEqual(res, { ok: false, error: 'timeout' });
    assert.equal(signal.aborted, true);
  });

  test(`${name}: signal 을 무시하고 영영 끝나지 않는 fetch 도 timeout 으로 끝난다`, async () => {
    const res = await call(opts(() => new Promise(() => {}), { timeoutMs: 20 }));
    assert.deepEqual(res, { ok: false, error: 'timeout' });
  });

  test(`${name}: 본문 읽기가 멈춰도 timeout`, async () => {
    const fetchImpl = async () => ({ ok: true, text: () => new Promise(() => {}) });
    assert.deepEqual(await call(opts(fetchImpl, { timeoutMs: 20 })), { ok: false, error: 'timeout' });
  });

  test(`${name}: 타임아웃 뒤에 fetch 가 늦게 실패해도 처리되지 않은 거부가 없다`, async () => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const fetchImpl = () => new Promise((_, reject) => setTimeout(() => reject(new TypeError('late failure')), 60));
      assert.deepEqual(await call(opts(fetchImpl, { timeoutMs: 10 })), { ok: false, error: 'timeout' });
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });

  test(`${name}: 응답이 오면 타임아웃 타이머를 정리한다`, async () => {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const active = new Set();
    globalThis.setTimeout = (fn, ms, ...rest) => {
      const id = realSet(() => {
        active.delete(id);
        fn(...rest);
      }, ms);
      active.add(id);
      return id;
    };
    globalThis.clearTimeout = (id) => {
      active.delete(id);
      realClear(id);
    };
    try {
      const body = name === 'fetchRanking' ? { ok: true, data: [] } : { ok: true };
      assert.equal((await call(opts(replyWith(body).fetchImpl))).ok, true);
      assert.equal(active.size, 0, '남은 타이머가 없어야 한다');
      await call(opts(replyWith('<html>').fetchImpl));
      assert.equal(active.size, 0, '실패 경로에서도 정리한다');
      await call(opts(async () => Promise.reject(new TypeError('x'))));
      assert.equal(active.size, 0);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
      for (const id of active) realClear(id);
    }
  });

  test(`${name}: 같은 이유로 연속 실패해도 항상 { ok: false, error } 모양`, async () => {
    const res = await call(opts(async () => Promise.reject(new TypeError('x'))));
    assert.deepEqual(Object.keys(res).sort(), ['error', 'ok']);
    assert.equal(res.ok, false);
    assert.equal(typeof res.error, 'string');
  });
}

test('기본 타임아웃은 8초다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = fetchRanking(10, opts(() => new Promise(() => {})));
  let settled = false;
  pending.then(() => void (settled = true));

  t.mock.timers.tick(7999);
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, '8초 전에는 끝나지 않는다');

  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { ok: false, error: 'timeout' });
});

test('잘못된 timeoutMs 는 무시하고 기본값을 쓴다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const timeoutMs of [0, -5, NaN, 'abc', null]) {
    const pending = fetchRanking(10, opts(() => new Promise(() => {}), { timeoutMs }));
    t.mock.timers.tick(7999);
    let settled = false;
    pending.then(() => void (settled = true));
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, `timeoutMs=${timeoutMs}`);
    t.mock.timers.tick(1);
    assert.deepEqual(await pending, { ok: false, error: 'timeout' });
  }
});

test('절대 throw/reject 하지 않는다 (이상한 인자)', async () => {
  const bad = [undefined, null, 0, 'str', {}, { url: undefined }];
  for (const o of bad) {
    const a = await fetchRanking(10, o);
    const b = await submitScore(payload(), o);
    for (const res of [a, b]) {
      assert.equal(res.ok, false);
      assert.equal(typeof res.error, 'string');
    }
  }
  // 기본 fetch 를 쓰는 경로에서도 외부로 나가지 않도록 URL 은 도달 불가능한 주소로
  const res = await fetchRanking(10, { url: 'http://127.0.0.1:9/exec', timeoutMs: 2000 });
  assert.equal(res.ok, false);
  assert.ok(['network', 'timeout'].includes(res.error), res.error);
});

// ═══════════════════════════════════════════════════════════
// google.script.run 통로 (Apps Script 웹 앱 안에서 직접 내보낸 게임 화면)
// ═══════════════════════════════════════════════════════════
// 가짜 실행기는 tests/helpers/gas-env.mjs 의 createScriptRun: withSuccessHandler/withFailureHandler 가 '새' 실행기를 돌려주고,
// 서버 함수는 비동기로 답하며, 인자/결과는 JSON 으로 표현되는 값만 통과한다. 체인을 잘못 쓰면 핸들러가 사라진다.

// 서버 함수를 지정해 가짜 google.script.run 을 만든다 (기본: 빈 랭킹, 제출 성공)
const gasServer = (fns = {}, options) =>
  createScriptRun({ apiRanking: () => ({ ok: true, data: [] }), apiSubmit: () => ({ ok: true }), ...fns }, options);
const wire = (body) => JSON.parse(JSON.stringify(body)); // 네트워크를 건너는 값은 JSON 이다 (fetch 의 response() 와 같다)

const GOOGLE_SHAPE_ERRORS = ['bad_request', 'invalid_nickname', 'invalid_score', 'implausible', 'throttled', 'server_busy'];

// 전역 window.google 을 잠깐 심고 반드시 되돌린다
async function withGoogle(google, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'google');
  globalThis.google = google;
  try {
    return await fn();
  } finally {
    if (had) Object.defineProperty(globalThis, 'google', had);
    else delete globalThis.google;
  }
}

// config.js 의 API_URL 만 바꾼 api.js 를 data: URL 로 불러온다 (파일을 쓰지 않는다). 기본 API_URL 경로를 시험할 때 쓴다.
async function importApiWithApiUrl(apiUrl) {
  const b64 = (text) => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
  const cfgSrc = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
  const apiSrc = readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');
  const cfg = cfgSrc.replace(/^export const API_URL = .*;$/m, `export const API_URL = ${JSON.stringify(apiUrl)};`);
  assert.notEqual(cfg, cfgSrc, 'config.js 의 API_URL 선언을 치환하지 못했다');
  const api = apiSrc.replace("from './config.js'", `from ${JSON.stringify(b64(cfg))}`);
  assert.notEqual(api, apiSrc, 'api.js 의 config import 를 치환하지 못했다');
  return import(b64(api));
}

// ── 성공 경로 ────────────────────────────────────────────

test('gas 통로 fetchRanking: apiRanking(limit) 을 부르고 행을 돌려준다', async () => {
  const { run, calls } = gasServer({ apiRanking: () => ({ ok: true, data: [row(), row({ nickname: 'b', score: 400 })] }) });
  const res = await fetchRanking(10, { gasRun: run });
  assert.deepEqual(res, {
    ok: true,
    data: [
      { nickname: '수박왕', score: 500, maxLevel: 7, at: 1700000000000 },
      { nickname: 'b', score: 400, maxLevel: 7, at: 1700000000000 },
    ],
  });
  assert.deepEqual(calls.map((c) => [c.fn, c.args, c.outcome]), [['apiRanking', [10], 'success']]);
});

test('gas 통로 fetchRanking: 기본 limit 과 보정은 fetch 통로와 같다', async () => {
  const limitOf = async (limit) => {
    const { run, calls } = gasServer();
    await fetchRanking(limit, { gasRun: run });
    return calls[0].args[0];
  };
  assert.equal(await limitOf(undefined), RANKING_LIMIT);
  assert.equal(await limitOf(5), 5);
  assert.equal(await limitOf(5.9), 5);
  assert.equal(await limitOf('7'), 7);
  assert.equal(await limitOf(50), 50);
  assert.equal(await limitOf(999), 50);
  for (const bad of [0, -3, NaN, 'abc', null]) assert.equal(await limitOf(bad), RANKING_LIMIT, String(bad));
});

test('gas 통로 fetchRanking: 서버가 limit 보다 많이 줘도 자르고, 깨진 행은 버린다 (fetch 통로와 똑같이 정리)', async () => {
  const data = [
    row({ nickname: 'ok1' }), null, 'string', 42, [], {}, row({ nickname: 123 }), row({ nickname: '' }), row({ nickname: '​‮' }),
    row({ nickname: 'ᅟ⠀' }), row({ nickname: 'textScore', score: 'abc' }), row({ nickname: 'negScore', score: -1 }),
    row({ nickname: 'ok2', score: '321', maxLevel: '4', at: '1700000000123' }), row({ nickname: 'ok3', score: 12.9, maxLevel: 3.7, at: 99.5 }),
    row({ nickname: 'ok4', maxLevel: 99 }), row({ nickname: 'ok5', maxLevel: -4 }), row({ nickname: '  a\u0000b\u0007‮c  ' }),
    ...Array.from({ length: 10 }, (_, i) => row({ nickname: 'x' + i })),
  ];
  for (const limit of [50, 3]) {
    const body = wire({ ok: true, data });
    const viaFetch = await fetchRanking(limit, opts(replyWith(body).fetchImpl));
    const viaGas = await fetchRanking(limit, { gasRun: gasServer({ apiRanking: () => body }).run });
    assert.equal(viaGas.ok, true);
    assert.deepEqual(viaGas, viaFetch, `limit=${limit}`);
  }
  const all = await fetchRanking(50, { gasRun: gasServer({ apiRanking: () => wire({ ok: true, data }) }).run });
  assert.deepEqual(all.data.slice(0, 6).map((r) => r.nickname), ['ok1', 'ok2', 'ok3', 'ok4', 'ok5', 'abc']);
});

test('gas 통로 submitScore: apiSubmit(payload) 에 계약된 필드만 JSON 으로 정리해 보낸다', async () => {
  const { run, calls } = gasServer();
  assert.deepEqual(await submitScore({ ...payload(), extra: 'x' }, { gasRun: run }), { ok: true });
  assert.deepEqual(calls.map((c) => [c.fn, c.outcome]), [['apiSubmit', 'success']]);
  assert.deepEqual(calls[0].args, [payload()]);

  // clientId 가 없으면 키 자체를 보내지 않는다 (google.script.run 은 undefined 값을 받지 못한다)
  const second = gasServer();
  assert.deepEqual(await submitScore({ ...payload(), clientId: undefined }, { gasRun: second.run }), { ok: true });
  assert.deepEqual(Object.keys(second.calls[0].args[0]).sort(), ['drops', 'maxLevel', 'nickname', 'playTimeMs', 'score']);

  // NaN/Infinity 는 fetch 경로의 JSON.stringify 처럼 null 이 된다 (서버가 invalid_score 로 거부한다)
  const third = gasServer();
  await submitScore(payload({ score: NaN, drops: Infinity }), { gasRun: third.run });
  assert.deepEqual([third.calls[0].args[0].score, third.calls[0].args[0].drops], [null, null]);
});

test('gas 통로: 서버가 받는 입력은 fetch 통로가 보낸 본문과 같다', async () => {
  for (const p of [payload(), payload({ clientId: undefined }), payload({ score: NaN }), { ...payload(), extra: 1 }]) {
    const sent = [];
    await submitScore(p, opts(recorder((url, init) => (sent.push(JSON.parse(init.body)), response({ ok: true }))).fetchImpl));
    const { run, calls } = gasServer();
    await submitScore(p, { gasRun: run });
    assert.deepEqual(calls[0].args, sent);
  }
});

// ── 서버 결과 / 실패 정규화 ────────────────────────────────

test('gas 통로: 서버 에러 코드는 그대로 전달한다 (성공 핸들러로 온 { ok: false })', async () => {
  for (const error of GOOGLE_SHAPE_ERRORS) {
    const fns = { apiSubmit: () => ({ ok: false, error }), apiRanking: () => ({ ok: false, error }) };
    assert.deepEqual(await submitScore(payload(), { gasRun: gasServer(fns).run }), { ok: false, error }, error);
    assert.deepEqual(await fetchRanking(10, { gasRun: gasServer(fns).run }), { ok: false, error }, error);
  }
});

test('gas 통로: 모르는 에러 코드나 error 없는 실패는 bad_response', async () => {
  for (const body of [{ ok: false }, { ok: false, error: 'boom' }, { ok: false, error: 42 }, { ok: false, error: { a: 1 } }]) {
    const run = gasServer({ apiSubmit: () => body, apiRanking: () => body }).run;
    assert.deepEqual(await submitScore(payload(), { gasRun: run }), { ok: false, error: 'bad_response' }, JSON.stringify(body));
    assert.deepEqual(await fetchRanking(10, { gasRun: run }), { ok: false, error: 'bad_response' }, JSON.stringify(body));
  }
});

test('gas 통로: 실패 핸들러(오프라인, 서버 예외, 할당량 초과)는 network', async () => {
  const fail = (message) => () => {
    throw new Error(message);
  };
  const run = gasServer({ apiSubmit: fail('Exceeded maximum execution time'), apiRanking: fail('Service invoked too many times') }).run;
  assert.deepEqual(await submitScore(payload(), { gasRun: run }), { ok: false, error: 'network' });
  assert.deepEqual(await fetchRanking(10, { gasRun: run }), { ok: false, error: 'network' });
  // 서버 함수가 직렬화할 수 없는 값(Date 등)을 돌려줘도 실패 핸들러로 가므로 network
  const illegal = gasServer({ apiRanking: () => ({ ok: true, data: [], at: new Date() }) }).run;
  assert.deepEqual(await fetchRanking(10, { gasRun: illegal }), { ok: false, error: 'network' });
});

test('gas 통로: { ok: boolean } 모양이 아닌 결과는 bad_response', async () => {
  // undefined 를 돌려주면 google.script.run 은 null 을 넘긴다
  for (const body of [undefined, null, 'text', 42, true, [], {}, { ok: 'yes' }, { ok: 1 }, { data: [] }, '<html>Sign in</html>']) {
    const run = gasServer({ apiSubmit: () => body, apiRanking: () => body }).run;
    assert.deepEqual(await submitScore(payload(), { gasRun: run }), { ok: false, error: 'bad_response' }, JSON.stringify(body));
    assert.deepEqual(await fetchRanking(10, { gasRun: run }), { ok: false, error: 'bad_response' }, JSON.stringify(body));
  }
  for (const body of [{ ok: true }, { ok: true, data: null }, { ok: true, data: {} }, { ok: true, data: 'x' }]) {
    const run = gasServer({ apiRanking: () => body }).run;
    assert.deepEqual(await fetchRanking(10, { gasRun: run }), { ok: false, error: 'bad_response' }, JSON.stringify(body));
  }
});

// ── 타임아웃 ─────────────────────────────────────────────

test('gas 통로: 영영 답이 없으면 timeout', async () => {
  const run = gasServer({}, { delayMs: Infinity }).run;
  assert.deepEqual(await fetchRanking(10, { gasRun: run, timeoutMs: 20 }), { ok: false, error: 'timeout' });
  assert.deepEqual(await submitScore(payload(), { gasRun: run, timeoutMs: 20 }), { ok: false, error: 'timeout' });
});

test('gas 통로: 타임아웃 뒤에 늦게 온 성공/실패 콜백은 무시하고 처리되지 않은 거부도 없다', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const lateKind of ['success', 'failure']) {
      const fns =
        lateKind === 'success'
          ? { apiRanking: () => ({ ok: true, data: [row()] }) }
          : { apiRanking: () => { throw new Error('late failure'); } };
      const { run, calls } = gasServer(fns, { delayMs: 60 });
      const res = await fetchRanking(10, { gasRun: run, timeoutMs: 10 });
      assert.deepEqual(res, { ok: false, error: 'timeout' }, lateKind);
      await new Promise((r) => setTimeout(r, 140));
      assert.equal(calls[0].outcome, lateKind, '늦은 콜백은 실제로 호출됐다 (그리고 무시됐다)');
    }
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('gas 통로: 기본 타임아웃은 8초이고 잘못된 timeoutMs 는 무시한다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const timeoutMs of [undefined, 0, -5, NaN, 'abc', null]) {
    const run = gasServer({}, { delayMs: Infinity }).run;
    const pending = fetchRanking(10, { gasRun: run, timeoutMs });
    let settled = false;
    pending.then(() => void (settled = true));
    t.mock.timers.tick(7999);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, `timeoutMs=${timeoutMs}: 8초 전에는 끝나지 않는다`);
    t.mock.timers.tick(1);
    assert.deepEqual(await pending, { ok: false, error: 'timeout' });
  }
});

test('gas 통로: 응답이 오면 타임아웃 타이머를 정리한다', async () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const active = new Set();
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const id = realSet(() => {
      active.delete(id);
      fn(...rest);
    }, ms);
    active.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    active.delete(id);
    realClear(id);
  };
  try {
    assert.equal((await fetchRanking(10, { gasRun: gasServer().run })).ok, true);
    assert.equal((await submitScore(payload(), { gasRun: gasServer().run })).ok, true);
    assert.equal(active.size, 0, '남은 타이머가 없어야 한다');
    const failing = gasServer({ apiRanking: () => { throw new Error('x'); } }).run;
    await fetchRanking(10, { gasRun: failing });
    assert.equal(active.size, 0, '실패 경로에서도 정리한다');
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    for (const id of active) realClear(id);
  }
});

// ── 체인은 호출마다 새로 만든다 ─────────────────────────────

test('gas 통로 체인: 동시에 여러 호출을 해도 결과가 섞이지 않는다', async () => {
  const delays = { apiRanking: 30, apiSubmit: 5 };
  const { run, calls } = gasServer(
    {
      apiRanking: (limit) => ({ ok: true, data: Array.from({ length: limit }, (_, i) => row({ nickname: `r${limit}-${i}` })) }),
      apiSubmit: (p) => (p.score === 1 ? { ok: false, error: 'invalid_score' } : { ok: true }),
    },
    { delayMs: (name) => delays[name] }
  );
  const [a, b, c, d] = await Promise.all([
    fetchRanking(3, { gasRun: run }),
    fetchRanking(5, { gasRun: run }),
    submitScore(payload({ score: 1 }), { gasRun: run }),
    submitScore(payload({ score: 2 }), { gasRun: run }),
  ]);
  assert.deepEqual(a.data.map((r) => r.nickname), ['r3-0', 'r3-1', 'r3-2']);
  assert.deepEqual(b.data.map((r) => r.nickname), ['r5-0', 'r5-1', 'r5-2', 'r5-3', 'r5-4']);
  assert.deepEqual(c, { ok: false, error: 'invalid_score' });
  assert.deepEqual(d, { ok: true });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((x) => x.outcome), ['success', 'success', 'success', 'success']);
});

test('gas 통로 체인: 호출마다 루트 실행기에서 withSuccessHandler 부터 새로 시작한다', async () => {
  const { run, calls } = gasServer();
  let chains = 0;
  // 루트에는 withSuccessHandler 만 있다. 루트에서 곧바로 서버 함수를 부르거나 핸들러를 한 번만 붙여 재사용하면 실패한다.
  const root = {
    withSuccessHandler(ok) {
      chains += 1;
      return run.withSuccessHandler(ok);
    },
  };
  assert.equal((await fetchRanking(10, { gasRun: root })).ok, true);
  assert.deepEqual(await submitScore(payload(), { gasRun: root }), { ok: true });
  assert.equal((await fetchRanking(10, { gasRun: root })).ok, true);
  assert.equal(chains, 3, '호출마다 새 체인');
  assert.deepEqual(calls.map((c) => c.fn), ['apiRanking', 'apiSubmit', 'apiRanking']);
});

test('가짜 실행기 자체 점검: 루트에 핸들러를 붙이고 반환값을 버리면 핸들러가 사라진다 (실제 google.script.run 처럼)', async () => {
  const { run, calls } = gasServer();
  let called = false;
  run.withSuccessHandler(() => void (called = true)); // 반환값(새 실행기)을 버렸다
  run.apiRanking(3);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(called, false);
  assert.equal(calls[0].outcome, 'success', '서버 함수는 실행됐지만 핸들러가 없다');
  assert.notEqual(run.withSuccessHandler(() => {}), run);
  assert.notEqual(run.withFailureHandler(() => {}), run);
  // 밑줄로 끝나는 서버 함수는 부를 수 없다
  assert.equal(createScriptRun({ secret_: () => 1, open: () => 1 }).run.secret_, undefined);
  // 인자에 undefined/Date 가 들어 있으면 호출 즉시 거부한다
  assert.throws(() => run.apiSubmit({ a: undefined }), /illegal value/);
  assert.throws(() => run.apiSubmit({ a: new Date() }), /illegal value/);
});

// ── 통로 우선순위 (호출 시점에 평가) ───────────────────────

test('우선순위: 명시한 gasRun > 전역 google.script.run > fetch(API_URL) > not_configured', async () => {
  const globalSide = gasServer({ apiRanking: () => ({ ok: true, data: [row({ nickname: 'global' })] }) });
  const overrideSide = gasServer({ apiRanking: () => ({ ok: true, data: [row({ nickname: 'override' })] }) });
  const fetched = replyWith({ ok: true, data: [row({ nickname: 'fetch' })] });
  const names = (res) => res.data.map((r) => r.nickname);

  await withGoogle({ script: { run: globalSide.run } }, async () => {
    // gasRun 이 전역 google 과 url+fetchImpl 둘 다 이긴다
    assert.deepEqual(names(await fetchRanking(10, { gasRun: overrideSide.run, url: URL_BASE, fetchImpl: fetched.fetchImpl })), ['override']);
    // gasRun 이 없고 url 을 명시하면 그 fetch 가 전역 google 보다 앞선다
    assert.deepEqual(names(await fetchRanking(10, opts(fetched.fetchImpl))), ['fetch']);
    // 아무것도 명시하지 않으면 전역 google.script.run
    assert.deepEqual(names(await fetchRanking(10)), ['global']);
    assert.deepEqual(names(await fetchRanking(10, {})), ['global']);
    assert.deepEqual(names(await fetchRanking(10, { fetchImpl: fetched.fetchImpl })), ['global'], 'fetchImpl 만으로는 통로를 바꾸지 않는다');
    // gasRun: null 은 gas 통로를 끈다 (전역 google 도 보지 않는다) -> API_URL 이 비어 있으므로 not_configured
    assert.deepEqual(await fetchRanking(10, { gasRun: null }), { ok: false, error: 'not_configured' });
    assert.deepEqual(names(await fetchRanking(10, { gasRun: null, url: URL_BASE, fetchImpl: fetched.fetchImpl })), ['fetch']);
    // 쓸 수 없는 gasRun 값도 같다
    for (const bad of [{}, 'run', 42, { withSuccessHandler: 1 }]) {
      assert.deepEqual(await fetchRanking(10, { gasRun: bad }), { ok: false, error: 'not_configured' }, String(bad));
    }
  });
  assert.equal(globalSide.calls.length, 3);
  assert.equal(overrideSide.calls.length, 1);
  assert.equal(fetched.calls.length, 2);

  // 전역 google 이 없으면 fetch, 둘 다 없으면 not_configured
  assert.deepEqual(names(await fetchRanking(10, opts(fetched.fetchImpl))), ['fetch']);
  assert.deepEqual(await fetchRanking(10), { ok: false, error: 'not_configured' });
});

test('우선순위: 전역 google.script.run 이 기본 API_URL(fetch) 보다 앞선다', async () => {
  const api = await importApiWithApiUrl('https://script.google.com/macros/s/FROM_CONFIG/exec');
  const fetched = replyWith({ ok: true, data: [row({ nickname: 'fetch' })] });
  const globalSide = gasServer({ apiRanking: () => ({ ok: true, data: [row({ nickname: 'global' })] }) });

  // google 이 없으면 config 의 API_URL 로 fetch
  assert.equal(api.isApiConfigured(), true);
  assert.deepEqual((await api.fetchRanking(10, { fetchImpl: fetched.fetchImpl })).data.map((r) => r.nickname), ['fetch']);
  assert.match(fetched.calls[0].url, /^https:\/\/script\.google\.com\/macros\/s\/FROM_CONFIG\/exec\?action=ranking/);

  // google 이 생기면(호출 시점에 평가) 같은 모듈이 곧바로 그쪽을 쓴다. fetchImpl 과 API_URL 이 있어도 fetch 는 쓰지 않는다.
  await withGoogle({ script: { run: globalSide.run } }, async () => {
    assert.deepEqual((await api.fetchRanking(10, { fetchImpl: fetched.fetchImpl })).data.map((r) => r.nickname), ['global']);
    assert.deepEqual(await api.submitScore(payload(), { fetchImpl: fetched.fetchImpl }), { ok: true });
  });
  assert.equal(fetched.calls.length, 1);
  assert.deepEqual(globalSide.calls.map((c) => c.fn), ['apiRanking', 'apiSubmit']);

  // 다시 사라지면 fetch 로 되돌아간다
  assert.deepEqual((await api.fetchRanking(10, { fetchImpl: fetched.fetchImpl })).data.map((r) => r.nickname), ['fetch']);
  assert.equal(fetched.calls.length, 2);
});

test('우선순위: 전역 google 은 import 시점이 아니라 호출 시점에 본다 (isApiConfigured 포함)', async () => {
  assert.equal(globalThis.google, undefined, '테스트 환경에는 google 이 없다');
  assert.equal(isApiConfigured(), false);
  assert.deepEqual(await fetchRanking(10), { ok: false, error: 'not_configured' });

  const { run, calls } = gasServer();
  await withGoogle({ script: { run } }, async () => {
    assert.equal(isApiConfigured(), true, 'import 한 뒤에 생긴 google 도 인식한다');
    assert.equal(isApiConfigured({}), true);
    assert.equal(isApiConfigured({ url: '' }), false, 'url 을 명시했으면 그것이 fetch 용 명시 값이다 (전역 google 보다 앞선다)');
    assert.equal(isApiConfigured({ gasRun: null }), false);
    assert.equal(isApiConfigured({ gasRun: run }), true);
    assert.deepEqual(await fetchRanking(10), { ok: true, data: [] });
  });
  assert.equal(calls.length, 1);

  assert.equal(isApiConfigured(), false, 'google 이 사라지면 다시 미설정');
  assert.deepEqual(await submitScore(payload()), { ok: false, error: 'not_configured' });
  assert.equal(calls.length, 1, '미설정이면 아무것도 부르지 않는다');

  // 같은 전역 객체를 다른 실행기로 바꾸면 다음 호출부터 새 실행기를 쓴다
  const first = gasServer();
  const second = gasServer();
  const google = { script: { run: first.run } };
  await withGoogle(google, async () => {
    await fetchRanking(10);
    google.script.run = second.run;
    await fetchRanking(10);
  });
  assert.deepEqual([first.calls.length, second.calls.length], [1, 1]);
});

test('우선순위: 쓸 수 없는 전역 google 값은 없는 것으로 취급한다', async () => {
  const unusable = [null, 0, 'x', {}, { script: null }, { script: {} }, { script: { run: null } }, { script: { run: {} } }, { script: { run: { withSuccessHandler: 'x' } } }];
  for (const google of unusable) {
    await withGoogle(google, async () => {
      assert.equal(isApiConfigured(), false, JSON.stringify(google));
      assert.deepEqual(await fetchRanking(10), { ok: false, error: 'not_configured' });
      assert.deepEqual(await submitScore(payload()), { ok: false, error: 'not_configured' });
    });
  }
  // 접근자가 던지는 google
  await withGoogle(
    {
      get script() {
        throw new Error('getter boom');
      },
    },
    async () => {
      assert.equal(isApiConfigured(), false);
      assert.deepEqual(await fetchRanking(10), { ok: false, error: 'not_configured' });
    }
  );
  // 쓸 수 없는 google 이 있어도 명시한 fetch 는 그대로 동작한다
  await withGoogle({ script: { run: {} } }, async () => {
    assert.equal((await fetchRanking(10, opts(replyWith({ ok: true, data: [] }).fetchImpl))).ok, true);
  });
});

// ── 절대 throw/reject 하지 않는다 ─────────────────────────

test('gas 통로: 이상한 실행기/콜백/입력에도 throw 하지 않고 { ok: false, error } 로 끝난다', async () => {
  const sync = (fn) => ({
    withSuccessHandler(ok) {
      return {
        withFailureHandler(err) {
          return fn(ok, err);
        },
      };
    },
  });
  const runners = {
    '체인이 던짐': { withSuccessHandler() { throw new Error('boom'); } },
    '체인 중간에 undefined': { withSuccessHandler: () => undefined },
    '서버 함수 이름이 없음': sync(() => ({})),
    '호출이 동기적으로 던짐': sync(() => ({ apiRanking() { throw new Error('sync boom'); }, apiSubmit() { throw new Error('sync boom'); } })),
  };
  for (const [name, gasRun] of Object.entries(runners)) {
    assert.deepEqual(await fetchRanking(10, { gasRun }), { ok: false, error: 'network' }, name);
    assert.deepEqual(await submitScore(payload(), { gasRun }), { ok: false, error: 'network' }, name);
  }

  // 핸들러를 동기적으로, 여러 번, 순서를 바꿔 호출해도 처음 결과만 쓴다
  const answer = (...calls) =>
    sync((ok, err) => ({
      apiRanking() {
        for (const c of calls) c === 'ok' ? ok({ ok: true, data: [row()] }) : err(new Error('x'));
      },
    }));
  assert.equal((await fetchRanking(10, { gasRun: answer('ok', 'fail', 'ok') })).ok, true);
  assert.deepEqual(await fetchRanking(10, { gasRun: answer('fail', 'ok') }), { ok: false, error: 'network' });

  // 접근자가 던지는 결과 객체
  const hostile = sync((ok) => ({
    apiRanking() {
      ok({ get ok() { throw new Error('getter boom'); } });
    },
  }));
  assert.deepEqual(await fetchRanking(10, { gasRun: hostile }), { ok: false, error: 'bad_response' });

  // 이상한 payload
  const circular = {};
  circular.self = circular;
  const { run, calls } = gasServer();
  for (const bad of [null, undefined, 'x', 42]) {
    assert.deepEqual(await submitScore(bad, { gasRun: run }), { ok: false, error: 'bad_request' });
  }
  assert.equal(calls.length, 0, 'payload 가 객체가 아니면 서버를 부르지 않는다');
  assert.deepEqual(await submitScore(payload({ nickname: circular }), { gasRun: run }), { ok: false, error: 'network' }, 'JSON 으로 만들 수 없는 값 (fetch 통로와 같다)');
  assert.deepEqual(await submitScore(payload({ nickname: circular }), opts(replyWith({ ok: true }).fetchImpl)), { ok: false, error: 'network' });
  assert.deepEqual(await submitScore(payload({ score: 10n }), { gasRun: run }), { ok: false, error: 'network' });
  assert.equal(calls.length, 0);
});
