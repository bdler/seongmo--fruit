import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RANKING_LIMIT, LAST_LEVEL } from '../js/config.js';
import { isApiConfigured, fetchRanking, submitScore } from '../js/api.js';

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
