import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { scoreOf, WATERMELON_PAIR_BONUS, LAST_LEVEL, MAX_DROP_LEVEL, TIMING } from '../js/config.js';

const SOURCE = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(readFileSync(new URL('../gas/appsscript.json', import.meta.url), 'utf8'));

const HEADER = ['timestamp', 'nickname', 'score', 'maxLevel', 'playTimeMs', 'drops', 'clientId'];
const SHEET_ID = 'sheet-id-0001';
const CID = 'abcdefghijklmnop1234';

// ── Apps Script 서비스 모의 객체 ──────────────────────────

function createSheet(rows) {
  const sheet = {
    rows,
    frozenRows: 0,
    numberFormats: [],
    reads: 0,
    getLastRow: () => sheet.rows.length,
    getRange(row, col, numRows, numCols) {
      // A1 표기('B:B')는 서식 지정에만 쓴다
      if (typeof row === 'string') {
        return {
          setNumberFormat(f) {
            if (sheet.formatError) throw sheet.formatError;
            sheet.numberFormats.push([row, f]);
          },
        };
      }
      return {
        // 화면에 보이는 문자열. 날짜/불리언 셀은 sheet.displayOf(값) 로 흉내 낸다 (기본은 String(값)).
        getDisplayValues() {
          return this.getValues().map((line) => line.map((v) => (sheet.displayOf ? sheet.displayOf(v) : String(v))));
        },
        getValues() {
          sheet.reads++;
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const line = sheet.rows[row - 1 + r] || [];
            out.push(Array.from({ length: numCols }, (_, c) => (line[col - 1 + c] === undefined ? '' : line[col - 1 + c])));
          }
          return out;
        },
        setValues(values) {
          for (let r = 0; r < numRows; r++) {
            const line = sheet.rows[row - 1 + r] || (sheet.rows[row - 1 + r] = []);
            for (let c = 0; c < numCols; c++) line[col - 1 + c] = values[r][c];
          }
        },
      };
    },
    appendRow(values) {
      if (sheet.appendError) throw sheet.appendError;
      sheet.rows.push(Array.from(values));
    },
    insertRowBefore: (n) => void sheet.rows.splice(n - 1, 0, []),
    setFrozenRows: (n) => void (sheet.frozenRows = n),
  };
  return sheet;
}

// 스크립트가 쓰는 전역 서비스를 직접 만든 모의 객체로 대체해 Code.gs 를 vm 에 올린다.
function createEnv({ rows, hasSheet = true, sheetId = SHEET_ID } = {}) {
  const env = {
    now: Date.UTC(2026, 0, 1),
    props: new Map(sheetId ? [['SHEET_ID', sheetId]] : []),
    cache: new Map(),
    cachePuts: [],
    cacheRemoves: [],
    lockWaits: [],
    lockHeld: false,
    lockFails: false,
    releases: 0,
    logs: [],
    errors: [],
    openedIds: [],
    sheet: hasSheet ? createSheet(rows || [HEADER]) : null,
    activeSpreadsheet: null,
  };

  const spreadsheet = {
    getId: () => SHEET_ID,
    getSheetByName: (name) => (name === 'scores' ? env.sheet : null),
    insertSheet(name) {
      assert.equal(name, 'scores');
      env.sheet = createSheet([]);
      return env.sheet;
    },
  };
  env.spreadsheet = spreadsheet;

  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(env.now);
    }
    static now() {
      return env.now;
    }
  }

  const sandbox = {
    Date: FakeDate,
    console: {
      log: (...a) => void env.logs.push(a.join(' ')),
      error: (...a) => void env.errors.push(a.join(' ')),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (env.props.has(k) ? env.props.get(k) : null),
        setProperty: (k, v) => void env.props.set(k, String(v)),
      }),
    },
    SpreadsheetApp: {
      openById(id) {
        env.openedIds.push(id);
        if (id !== SHEET_ID) throw new Error('Unexpected error: Requested entity was not found. (id=' + id + ')');
        return spreadsheet;
      },
      getActiveSpreadsheet: () => env.activeSpreadsheet,
    },
    LockService: {
      getScriptLock: () => ({
        tryLock(ms) {
          env.lockWaits.push(ms);
          if (env.lockFails) return false;
          env.lockHeld = true;
          return true;
        },
        releaseLock() {
          env.releases++;
          env.lockHeld = false;
        },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get(k) {
          const hit = env.cache.get(k);
          if (!hit) return null;
          if (env.now >= hit.expiresAt) {
            env.cache.delete(k);
            return null;
          }
          return hit.value;
        },
        put(k, v, sec) {
          env.cachePuts.push({ key: k, sec });
          env.cache.set(k, { value: v, expiresAt: env.now + sec * 1000 });
        },
        remove(k) {
          env.cacheRemoves.push(k);
          env.cache.delete(k);
        },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (text) => ({
        text,
        mime: null,
        setMimeType(m) {
          this.mime = m;
          return this;
        },
        getContent() {
          return this.text;
        },
      }),
    },
  };

  // 최상위 const 는 vm 컨텍스트의 속성이 되지 않으므로 마지막 표현식으로 함께 돌려받는다.
  const code = `${SOURCE}
;({ doGet, doPost, setup, submitScore_, sanitizeNickname_, isPlausible_, getRanking_,
    consts: { MAX_SCORE, MAX_SCORE_PER_DROP, MIN_MS_PER_DROP, RANKING_KEEP, RANKING_CACHE_SEC, THROTTLE_SEC, MAX_NICKNAME } });`;
  env.gas = vm.runInContext(code, vm.createContext(sandbox), { filename: 'Code.gs' });
  return env;
}

// 응답은 문자열로 받아 이쪽 realm 의 JSON.parse 로 풀어야 deepStrictEqual 이 prototype 불일치로 실패하지 않는다.
const parse = (out) => JSON.parse(out.getContent());
const get = (env, params) => parse(env.gas.doGet({ parameter: params }));
const post = (env, body) =>
  parse(env.gas.doPost({ postData: { type: 'text/plain', contents: typeof body === 'string' ? body : JSON.stringify(body) } }));

const valid = (over = {}) => ({
  nickname: '수박왕',
  score: 321,
  maxLevel: 7,
  playTimeMs: 90000,
  drops: 80,
  clientId: CID,
  ...over,
});

const row = (ts, nickname, score, maxLevel = 3, extra = [60000, 50, '']) => [new Date(ts), nickname, score, maxLevel, ...extra];

// ── 랭킹 조회 ────────────────────────────────────────────

test('랭킹: 점수 내림차순, 같으면 먼저 기록한 쪽이 위, 응답 모양', () => {
  const env = createEnv({
    rows: [HEADER, row(3000, 'c', 100), row(1000, 'a', 500), row(2000, 'b', 100), row(500, 'd', 100)],
  });
  const res = get(env, { action: 'ranking', limit: '10' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.map((r) => r.nickname), ['a', 'd', 'b', 'c']);
  assert.deepEqual(res.data[0], { nickname: 'a', score: 500, maxLevel: 3, at: 1000 });
  assert.deepEqual(Object.keys(res).sort(), ['data', 'ok']);
});

test('랭킹: 응답은 JSON MIME 타입이다', () => {
  const env = createEnv();
  assert.equal(env.gas.doGet({ parameter: {} }).mime, 'JSON');
  assert.equal(env.gas.doPost({ postData: { contents: '{' } }).mime, 'JSON');
});

test('랭킹: limit 기본 10, 1..50 으로 보정, 잘못된 값은 기본값', () => {
  const rows = [HEADER];
  for (let i = 0; i < 60; i++) rows.push(row(1000 + i, 'p' + i, 1000 - i));
  const env = createEnv({ rows });
  const len = (params) => get(env, params).data.length;

  assert.equal(len({}), 10);
  assert.equal(len({ action: 'ranking' }), 10);
  assert.equal(len({ limit: '3' }), 3);
  assert.equal(len({ limit: '3.9' }), 3);
  assert.equal(len({ limit: '0' }), 1);
  assert.equal(len({ limit: '-5' }), 1);
  assert.equal(len({ limit: '1000' }), 50);
  assert.equal(len({ limit: 'Infinity' }), 50);
  assert.equal(len({ limit: 'abc' }), 10);
  assert.equal(len({ limit: '' }), 10);
  // 상위 50개만 남고 순서는 유지된다
  const all = get(env, { limit: '50' }).data;
  assert.equal(all[0].nickname, 'p0');
  assert.equal(all[49].nickname, 'p49');
});

test('랭킹: 캐시를 60초 쓰고 만료 후 시트를 다시 읽는다', () => {
  const env = createEnv({ rows: [HEADER, row(1000, 'a', 10)] });
  get(env, {});
  assert.equal(env.sheet.reads, 1);
  assert.deepEqual(env.cachePuts, [{ key: 'ranking', sec: 60 }]);

  get(env, { limit: '5' });
  get(env, {});
  assert.equal(env.sheet.reads, 1, '캐시 적중 시 시트를 읽지 않는다');

  // 시트를 손으로 고쳐도 TTL 안에서는 캐시가 보인다
  env.sheet.rows.push(row(2000, 'b', 99));
  assert.equal(get(env, {}).data.length, 1);
  env.now += 59 * 1000;
  assert.equal(get(env, {}).data.length, 1);
  env.now += 2 * 1000;
  assert.deepEqual(get(env, {}).data.map((r) => r.nickname), ['b', 'a']);
  assert.equal(env.sheet.reads, 2);
});

test('랭킹: 깨진 캐시 값은 무시하고 시트에서 다시 만든다', () => {
  const env = createEnv({ rows: [HEADER, row(1000, 'a', 10)] });
  env.cache.set('ranking', { value: '{not json', expiresAt: Infinity });
  assert.equal(get(env, {}).data[0].nickname, 'a');
  env.cache.set('ranking', { value: '{"x":1}', expiresAt: Infinity });
  assert.equal(get(env, {}).data[0].nickname, 'a');
});

test('랭킹: 헤더 행은 건너뛰고, 헤더만 있거나 빈 시트는 빈 배열', () => {
  const withData = createEnv({ rows: [HEADER, row(1000, 'a', 10)] });
  assert.deepEqual(get(withData, {}).data.map((r) => r.nickname), ['a']);
  assert.deepEqual(get(createEnv({ rows: [HEADER] }), {}), { ok: true, data: [] });
  assert.deepEqual(get(createEnv({ rows: [] }), {}), { ok: true, data: [] });
});

test('랭킹: 비었거나 깨진 행은 건너뛴다', () => {
  const garbage = [
    [],
    ['', '', '', '', '', '', ''],
    [new Date(1), '', 50, 1], // 닉네임 없음
    [new Date(2), '   ', 50, 1],
    [new Date(3), 'noScore', '', 1],
    [new Date(4), 'textScore', 'abc', 1],
    [new Date(5), 'floatScore', 12.5, 1],
    [new Date(6), 'negScore', -1, 1],
    [new Date(7), 'hugeScore', 1e9, 1],
    [new Date(8), 'infScore', Infinity, 1],
    [new Date(9), 'badLevel', 50, 'x'],
    [new Date(10), 'highLevel', 50, 11],
    [new Date(11), 'noLevel', 50, ''],
    ['', 'noTime', 50, 1],
    [null, 'nullTime', 50, 1],
    ['not a date', 'junkTime', 50, 1],
    [new Date(NaN), 'invalidDate', 50, 1],
    [new Date(12), { x: 1 }, 50, 1], // 닉네임이 객체
    [new Date(14), '\u200b\u202e', 50, 1], // 보이지 않는 문자뿐
  ];
  const env = createEnv({ rows: [HEADER, ...garbage, row(100, 'ok', 40), row(200, 'ok2', 30)] });
  assert.deepEqual(get(env, {}).data.map((r) => r.nickname), ['ok', 'ok2']);
});

test('랭킹: 숫자 셀로 바뀐 닉네임과 숫자 문자열 점수는 받아들인다', () => {
  const env = createEnv({ rows: [HEADER, [new Date(1000), 1234, '77', '2', 1, 1, '']] });
  assert.deepEqual(get(env, {}).data, [{ nickname: '1234', score: 77, maxLevel: 2, at: 1000 }]);
});

test('랭킹: 인젝션 방지용 접두 따옴표는 표시할 때 벗기고 제어문자는 지운다', () => {
  const env = createEnv({ rows: [HEADER, row(1, "'-_-", 30), row(2, "'quoted", 20), row(3, 'bell\u0007\u202e!', 10)] });
  assert.deepEqual(get(env, {}).data.map((r) => r.nickname), ['-_-', "'quoted", 'bell!']);
});

test('랭킹: 시트 오류는 내부 정보 없이 server_busy 로 응답한다', () => {
  for (const env of [
    createEnv({ hasSheet: false }), // scores 시트 없음
    createEnv({ sheetId: null }), // setup() 미실행
    createEnv({ sheetId: 'wrong-id' }), // openById 가 예외
  ]) {
    const out = env.gas.doGet({ parameter: {} });
    assert.deepEqual(parse(out), { ok: false, error: 'server_busy' });
    assert.doesNotMatch(out.getContent(), /Error|stack|setup|SHEET_ID|wrong-id|\bat\b/);
    assert.equal(env.errors.length, 1, '원인은 실행 로그에 남는다');
  }
});

test('GET: 알 수 없는 action 은 bad_request, e 가 비어도 동작한다', () => {
  const env = createEnv({ rows: [HEADER, row(1, 'a', 1)] });
  assert.deepEqual(get(env, { action: 'delete' }), { ok: false, error: 'bad_request' });
  assert.deepEqual(get(env, { action: 'Ranking' }), { ok: false, error: 'bad_request' });
  assert.equal(parse(env.gas.doGet(undefined)).ok, true);
  assert.equal(parse(env.gas.doGet({})).ok, true);
});

// ── 점수 제출: 정상 경로 ─────────────────────────────────

test('제출: 정상 입력은 7열 행을 추가하고 락/캐시를 처리한다', () => {
  const env = createEnv();
  const res = post(env, valid());
  assert.deepEqual(res, { ok: true });

  assert.equal(env.sheet.rows.length, 2);
  const [ts, nickname, score, maxLevel, playTimeMs, drops, clientId] = env.sheet.rows[1];
  assert.equal(env.sheet.rows[1].length, 7);
  assert.equal(Object.prototype.toString.call(ts), '[object Date]');
  assert.equal(ts.getTime(), env.now);
  assert.deepEqual([nickname, score, maxLevel, playTimeMs, drops, clientId], ['수박왕', 321, 7, 90000, 80, CID]);

  assert.deepEqual(env.lockWaits, [5000]);
  assert.equal(env.releases, 1);
  assert.equal(env.lockHeld, false);
  assert.deepEqual(env.cacheRemoves, ['ranking']);
});

test('제출: clientId 는 선택 값이고 숫자 문자열 필드도 정수로 받는다', () => {
  const env = createEnv();
  assert.deepEqual(post(env, valid({ clientId: undefined })), { ok: true });
  assert.deepEqual(post(env, valid({ clientId: null })), { ok: true });
  assert.equal(env.sheet.rows[1][6], '');
  assert.deepEqual(post(env, valid({ score: '100', maxLevel: '3', playTimeMs: '90000', drops: '80', clientId: CID })), { ok: true });
  assert.deepEqual(env.sheet.rows[3].slice(2, 6), [100, 3, 90000, 80]);
});

test('제출: 새 기록이 즉시 랭킹에 반영된다 (캐시 무효화)', () => {
  const env = createEnv({ rows: [HEADER, row(1000, 'old', 100)] });
  assert.deepEqual(get(env, {}).data.map((r) => r.nickname), ['old']);
  assert.equal(env.cache.has('ranking'), true);

  assert.deepEqual(post(env, valid({ nickname: 'new', score: 900 })), { ok: true });
  assert.equal(env.cache.has('ranking'), false);
  assert.deepEqual(get(env, {}).data.map((r) => r.nickname), ['new', 'old']);
  assert.equal(env.sheet.reads, 3, '랭킹 읽기 2번 + 제출 때 재전송 확인(최근 행 읽기) 1번');
});

test('제출: 제출한 점수가 getRanking 정렬에서 같은 점수의 기존 기록 뒤에 온다', () => {
  const env = createEnv({ rows: [HEADER, row(1000, 'first', 321)] });
  env.now = 5000;
  post(env, valid({ nickname: 'second' }));
  assert.deepEqual(get(env, {}).data.map((r) => r.nickname), ['first', 'second']);
});

// ── 점수 제출: 잘못된 입력 ───────────────────────────────

test('제출: 잘못된 입력은 코드별로 거부하고 시트/락을 건드리지 않는다', () => {
  const MAX = 100000;
  const cases = [
    // 닉네임
    ['닉네임 없음', { nickname: undefined }, 'invalid_nickname'],
    ['닉네임 빈 문자열', { nickname: '' }, 'invalid_nickname'],
    ['닉네임 공백뿐', { nickname: '   \t ' }, 'invalid_nickname'],
    ['닉네임 제어문자뿐', { nickname: '\u0000\u0007\u001f\u007f' }, 'invalid_nickname'],
    ['닉네임 제로폭/RTL 문자뿐', { nickname: '\u200b\u200d\u202e\ufeff' }, 'invalid_nickname'],
    ['닉네임 한글 채움 문자뿐', { nickname: '\u3164\u3164' }, 'invalid_nickname'],
    ['닉네임 null', { nickname: null }, 'invalid_nickname'],
    ['닉네임 숫자', { nickname: 123 }, 'invalid_nickname'],
    ['닉네임 객체', { nickname: { a: 1 } }, 'invalid_nickname'],
    ['닉네임 배열', { nickname: ['a'] }, 'invalid_nickname'],
    // 점수
    ['점수 없음', { score: undefined }, 'invalid_score'],
    ['점수 null (NaN/Infinity 의 JSON 표현)', { score: null }, 'invalid_score'],
    ['점수 음수', { score: -1 }, 'invalid_score'],
    ['점수 소수', { score: 1.5 }, 'invalid_score'],
    ['점수 문자열', { score: 'abc' }, 'invalid_score'],
    ['점수 숫자+문자', { score: '12abc' }, 'invalid_score'],
    ['점수 빈 문자열', { score: '' }, 'invalid_score'],
    ['점수 불리언', { score: true }, 'invalid_score'],
    ['점수 배열', { score: [5] }, 'invalid_score'],
    ['점수 상한 초과', { score: MAX + 1 }, 'invalid_score'],
    ['점수 지수 표기', { score: '1e3' }, 'invalid_score'],
    // 그 밖의 필드
    ['maxLevel 없음', { maxLevel: undefined }, 'bad_request'],
    ['maxLevel 음수', { maxLevel: -1 }, 'bad_request'],
    ['maxLevel 11', { maxLevel: 11 }, 'bad_request'],
    ['maxLevel 소수', { maxLevel: 2.5 }, 'bad_request'],
    ['maxLevel 문자열', { maxLevel: 'x' }, 'bad_request'],
    ['drops 없음', { drops: undefined }, 'bad_request'],
    ['drops 0', { drops: 0 }, 'bad_request'],
    ['drops 5001', { drops: 5001 }, 'bad_request'],
    ['drops 소수', { drops: 1.5 }, 'bad_request'],
    ['playTimeMs 없음', { playTimeMs: undefined }, 'bad_request'],
    ['playTimeMs 0', { playTimeMs: 0 }, 'bad_request'],
    ['playTimeMs 음수', { playTimeMs: -5 }, 'bad_request'],
    ['playTimeMs 24시간 초과', { playTimeMs: 86400001 }, 'bad_request'],
    ['playTimeMs 소수', { playTimeMs: 1000.5 }, 'bad_request'],
    ['clientId 너무 짧음', { clientId: 'short' }, 'bad_request'],
    ['clientId 너무 김', { clientId: 'a'.repeat(65) }, 'bad_request'],
    ['clientId 허용되지 않는 문자', { clientId: 'abcdefghijklmnop 123!' }, 'bad_request'],
    ['clientId 빈 문자열', { clientId: '' }, 'bad_request'],
    ['clientId 숫자', { clientId: 12345678901234567890 }, 'bad_request'],
    // 타당성
    ['점수가 드롭 수 대비 과도', { drops: 10, playTimeMs: 90000, score: 1201 }, 'implausible'],
    ['플레이 시간이 드롭 수 대비 과도하게 짧음', { drops: 10, playTimeMs: 3599, score: 100 }, 'implausible'],
  ];

  const env = createEnv();
  for (const [name, patch, error] of cases) {
    const body = valid(patch);
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete body[k];
    assert.deepEqual(post(env, body), { ok: false, error }, name);
  }
  assert.equal(env.sheet.rows.length, 1, '거부된 요청은 행을 추가하지 않는다');
  assert.deepEqual(env.lockWaits, [], '검증 단계에서 걸러져 락을 잡지 않는다');
  assert.deepEqual(env.cacheRemoves, []);
});

test('제출: 형식이 깨진 요청 본문은 bad_request', () => {
  const env = createEnv();
  const bad = (contents) => assert.deepEqual(post(env, contents), { ok: false, error: 'bad_request' }, String(contents));
  bad('');
  bad('{oops');
  bad('null');
  bad('123');
  bad('"text"');
  bad('[]');
  bad('[{"nickname":"a"}]');
  bad('true');
  bad(JSON.stringify(valid({ nickname: 'x'.repeat(5000) }))); // 과도하게 큰 본문

  const call = (e) => parse(env.gas.doPost(e));
  assert.deepEqual(call(undefined), { ok: false, error: 'bad_request' });
  assert.deepEqual(call({}), { ok: false, error: 'bad_request' });
  assert.deepEqual(call({ postData: {} }), { ok: false, error: 'bad_request' });
  assert.deepEqual(call({ postData: { contents: null } }), { ok: false, error: 'bad_request' });
  assert.deepEqual(call({ postData: { contents: 42 } }), { ok: false, error: 'bad_request' });
  assert.equal(env.sheet.rows.length, 1);
  assert.deepEqual(env.lockWaits, []);
});

test('제출: 경계값(점수 0, maxLevel 0/10, drops 1/5000, 최대 시간)은 통과한다', () => {
  const env = createEnv();
  assert.deepEqual(post(env, valid({ score: 0, maxLevel: 0, drops: 1, playTimeMs: 1, clientId: undefined })), { ok: true });
  assert.deepEqual(post(env, valid({ score: 120, maxLevel: 10, drops: 1, playTimeMs: 1, clientId: undefined })), { ok: true });
  assert.deepEqual(post(env, valid({ score: 100000, maxLevel: 10, drops: 5000, playTimeMs: 86400000, clientId: undefined })), { ok: true });
  assert.equal(env.sheet.rows.length, 4);
});

// ── 닉네임 정제 ──────────────────────────────────────────

test('닉네임: 제어문자 제거, 앞뒤 공백 제거, 12자 제한', () => {
  const env = createEnv();
  const clean = (s) => env.gas.sanitizeNickname_(s);
  assert.equal(clean('  수박왕  '), '수박왕');
  assert.equal(clean('a\u0000b\u0007c\u007fd\ne\tf'), 'abcdef');
  assert.equal(clean('a\u200bb\u202ec\ufeffd'), 'abcd');
  assert.equal(clean('가나다라마바사아자차카타파하'), '가나다라마바사아자차카타');
  assert.equal(clean('가나다라마바사아자차카   타'), '가나다라마바사아자차카', '자른 뒤 남은 끝 공백도 정리');
  assert.equal(clean('abc def'), 'abc def', '중간 공백은 유지');
  assert.equal(clean(undefined), '');
  assert.equal(clean(42), '');
});

test('닉네임: 이모지(서로게이트 쌍)를 반으로 자르지 않는다', () => {
  const env = createEnv();
  const nick = '🍉'.repeat(15);
  const out = env.gas.sanitizeNickname_(nick);
  assert.equal(Array.from(out).length, 12);
  assert.equal(out, '🍉'.repeat(12));
});

test('닉네임: 수식 인젝션 시작 문자(= + - @, 탭/CR)를 무력화한다', () => {
  const env = createEnv();
  const starters = ['=1+1', '+1', '-1', '@SUM(A1)', '=HYPERLINK("http://evil","x")', '\t=1+1', '\r=1+1', ' =1+1', '\u200b=1+1'];
  for (const raw of starters) {
    assert.deepEqual(post(env, valid({ nickname: raw, clientId: undefined })), { ok: true }, raw);
  }
  const stored = env.sheet.rows.slice(1).map((r) => r[1]);
  assert.equal(stored.length, starters.length);
  for (const cell of stored) {
    assert.match(cell, /^'[=+\-@]/, `접두 따옴표가 붙어야 한다: ${cell}`);
    assert.doesNotMatch(cell, /^[=+\-@\t\r]/, '수식으로 시작하면 안 된다');
  }
  // 인젝션이 아닌 닉네임은 그대로 둔다
  assert.equal(env.gas.sanitizeNickname_('a=b'), 'a=b');
  assert.equal(env.gas.sanitizeNickname_("'안녕"), "'안녕");
});

test('닉네임: 보이지 않는 문자뿐이면 거부한다 (한글 채움 문자, 점자 빈칸, 아랍 문자 표시 등)', () => {
  const env = createEnv();
  const invisible = [
    ['한글 초성 채움 U+115F', '\u115f'],
    ['한글 중성 채움 U+1160', '\u1160'],
    ['초성+중성 채움', '\u115f\u1160'],
    ['한글 채움 U+3164', '\u3164'],
    ['반각 한글 채움 U+FFA0', '\uffa0'],
    ['점자 빈칸 U+2800', '\u2800'.repeat(12)],
    ['아랍 문자 표시 U+061C', '\u061c'],
    ['결합 문자 연결 U+034F', '\u034f'],
    ['몽골 모음 구분자 U+180E', '\u180e'],
    ['크메르 U+17B4/17B5', '\u17b4\u17b5'],
    ['변형 선택자만 U+FE0F', '\ufe0f'],
    ['변형 선택자 여러 개와 공백', ' \ufe0e\ufe0f \ufe00'],
    ['태그 문자만 U+E0041', '\u{e0041}'],
    ['여러 종류가 섞인 보이지 않는 문자', '\u115f\u2800\u061c\ufe0f\u{e0041}\u200b'],
  ];
  for (const [name, raw] of invisible) {
    assert.equal(env.gas.sanitizeNickname_(raw), '', name);
    assert.deepEqual(post(env, valid({ nickname: raw, clientId: undefined })), { ok: false, error: 'invalid_nickname' }, name);
  }
  assert.equal(env.sheet.rows.length, 1, '아무 행도 추가되지 않는다');
});

test('닉네임: 보이는 글자가 있으면 보이지 않는 문자만 지우고, 이모지의 변형 선택자/태그는 지킨다', () => {
  const env = createEnv();
  const clean = (s) => env.gas.sanitizeNickname_(s);
  assert.equal(clean('수\u115f박\u2800왕\u061c'), '수박왕');
  assert.equal(clean('\u3164수박\u1160'), '수박');
  assert.equal(clean('\u2764\ufe0f'), '\u2764\ufe0f', '❤️ 은 변형 선택자를 유지');
  const england = '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}';
  assert.equal(clean(england), england, '🏴󠁧󠁢󠁥󠁮󠁧󠁿 은 태그 문자를 유지');
  assert.equal(clean('A\ufe0f'), 'A\ufe0f');
  assert.equal(clean('^^'), '^^', '기호만으로 된 닉네임은 보이는 글자다');
  assert.equal(clean('...'), '...');
  assert.equal(clean('🇰🇷'), '🇰🇷');
});

test('랭킹: 보이는 글자가 없는 닉네임의 행은 건너뛴다', () => {
  const env = createEnv({
    rows: [HEADER, row(1, '\u2800', 90), row(2, '\u115f\u1160', 80), row(3, '\ufe0f', 70), row(4, 'ok', 10)],
  });
  assert.deepEqual(get(env, {}).data.map((r) => r.nickname), ['ok']);
});

// ── 닉네임 열 서식 (날짜/숫자/불리언으로 바뀌는 닉네임) ───────────

test('제출: 닉네임 열을 일반 텍스트로 한 번만 고정한다 (setup 을 건너뛴 수동 배포 포함)', () => {
  const env = createEnv(); // setup() 없이 SHEET_ID 만 있는 상태
  assert.deepEqual(post(env, valid({ nickname: '3-4' })), { ok: true });
  assert.deepEqual(env.sheet.numberFormats, [['B:B', '@']]);
  assert.equal(env.props.get('NICKNAME_TEXT_FORMAT'), SHEET_ID);
  env.now += 11000;
  assert.deepEqual(post(env, valid({ nickname: '1/2', playTimeMs: 90001 })), { ok: true });
  assert.equal(env.sheet.numberFormats.length, 1, '두 번째 제출은 서식을 다시 지정하지 않는다');
});

test('제출: 서식 지정이 실패해도 제출은 성공하고 원인은 로그에 남는다', () => {
  const env = createEnv();
  env.sheet.formatError = new Error('Exception: format denied');
  assert.deepEqual(post(env, valid()), { ok: true });
  assert.equal(env.sheet.rows.length, 2);
  assert.equal(env.errors.length, 1);
  assert.match(env.errors[0], /format denied/);
  assert.equal(env.props.has('NICKNAME_TEXT_FORMAT'), false, '실패했으니 다음 제출에서 다시 시도한다');
});

test('랭킹: 날짜/불리언으로 바뀐 닉네임 셀은 시트에 보이는 문자열로 보여 주고 행을 버리지 않는다', () => {
  const coerced = new Date(2026, 2, 4); // "3-4" 가 날짜 셀이 된 경우
  const env = createEnv({ rows: [HEADER, row(1, coerced, 900), row(2, true, 800), row(3, 'plain', 700), row(4, 7, 600)] });
  env.sheet.displayOf = (v) => (Object.prototype.toString.call(v) === '[object Date]' ? '3월 4일' : v === true ? 'TRUE' : String(v));
  assert.deepEqual(get(env, {}).data.map((r) => [r.nickname, r.score]), [['3월 4일', 900], ['TRUE', 800], ['plain', 700], ['7', 600]]);
  assert.equal(env.sheet.reads, 2, '값 읽기 1번 + 표시값 읽기 1번 (표시값은 필요할 때 한 번만)');
});

test('랭킹: 닉네임 셀이 모두 문자열/숫자면 표시값을 따로 읽지 않는다', () => {
  const env = createEnv({ rows: [HEADER, row(1, 'a', 3), row(2, 12, 2)] });
  env.sheet.displayOf = () => {
    throw new Error('표시값을 읽으면 안 됨');
  };
  assert.deepEqual(get(env, {}).data.map((r) => r.nickname), ['a', '12']);
});

// ── 타당성 검사 ──────────────────────────────────────────

test('타당성: 점수 상한은 드롭당 이론 최댓값을 넘고 약간의 여유만 둔다', () => {
  const { consts } = createEnv().gas;

  // 질량 1단위(체리 1개)당 얻을 수 있는 점수의 상한
  let perUnit = WATERMELON_PAIR_BONUS / 2 ** (LAST_LEVEL + 1);
  for (let level = 1; level <= LAST_LEVEL; level++) perUnit += scoreOf(level) / 2 ** level;
  const perDrop = perUnit * 2 ** MAX_DROP_LEVEL;

  assert.ok(Math.abs(perDrop - 111.34) < 0.01, `이론 상한은 약 111.3 (실제 ${perDrop})`);
  assert.ok(consts.MAX_SCORE_PER_DROP >= perDrop, '이론 상한보다 작으면 정상 플레이가 거부된다');
  assert.ok(consts.MAX_SCORE_PER_DROP <= perDrop * 1.1, '여유가 10%를 넘으면 검사가 느슨해진다');
});

test('타당성: 어떤 단계의 과일만 떨어뜨려 끝까지 합쳐도(최대 득점 플레이) 상한을 넘지 않는다', () => {
  const { consts } = createEnv().gas;
  // 같은 단계가 만나면 즉시 합쳐지는 이진 카운터. 수박 2개(질량 2048)를 정확히 소진할 만큼 드롭한다.
  const play = (dropLevel) => {
    const pending = new Array(LAST_LEVEL + 1).fill(false);
    const add = (level) => {
      let pts = 0;
      for (;;) {
        if (!pending[level]) {
          pending[level] = true;
          return pts;
        }
        pending[level] = false;
        if (level === LAST_LEVEL) return pts + WATERMELON_PAIR_BONUS;
        level += 1;
        pts += scoreOf(level);
      }
    };
    const drops = 2 ** (LAST_LEVEL + 1 - dropLevel);
    let total = 0;
    for (let i = 0; i < drops; i++) total += add(dropLevel);
    assert.equal(pending.some(Boolean), false, '질량이 남지 않고 모두 합쳐진다');
    return { drops, perDrop: total / drops };
  };

  const perDrop = [];
  for (let level = 0; level <= MAX_DROP_LEVEL; level++) {
    const r = play(level);
    perDrop.push(r.perDrop);
    assert.ok(r.perDrop <= consts.MAX_SCORE_PER_DROP, `Lv${level} 드롭: 드롭당 ${r.perDrop}`);
  }
  // Lv4 로만 채우는 판이 가장 득점이 높다 (실제 최댓값은 상한 120보다 훨씬 작다)
  assert.equal(Math.max(...perDrop), perDrop[MAX_DROP_LEVEL]);
  assert.ok(Math.abs(perDrop[MAX_DROP_LEVEL] - 28.34) < 0.01, `실제 최댓값 ${perDrop[MAX_DROP_LEVEL]}`);
});

test('타당성: 최소 시간은 쿨다운 간격보다 느슨하고 (drops - 1) 기준이다', () => {
  const { consts, isPlausible_ } = createEnv().gas;
  assert.ok(consts.MIN_MS_PER_DROP <= TIMING.dropCooldown, '쿨다운(500ms)을 지키는 정상 플레이를 막으면 안 된다');

  const okAt = (score, drops, ms) => isPlausible_(score, drops, ms);
  assert.equal(okAt(0, 10, 9 * 400), true);
  assert.equal(okAt(0, 10, 9 * 400 - 1), false);
  assert.equal(okAt(0, 1, 1), true, '드롭 1번은 간격이 없다');
  assert.equal(okAt(1200, 10, 90000), true);
  assert.equal(okAt(1201, 10, 90000), false);
});

test('제출: 정확히 쿨다운 간격으로 계속 드롭한 가장 빠른 판은 통과한다', () => {
  const env = createEnv();
  const drops = 200;
  // 첫 드롭 직후부터 500ms 간격 -> 마지막 드롭까지 (drops - 1) * 500 ms
  const playTimeMs = (drops - 1) * TIMING.dropCooldown;
  assert.deepEqual(post(env, valid({ drops, playTimeMs, score: 6000 })), { ok: true });
});

// ── 제출 빈도 제한 / 락 / 내부 오류 ───────────────────────

test('throttle: 같은 clientId 는 10초 안에 다시 제출할 수 없다', () => {
  const env = createEnv();
  assert.deepEqual(post(env, valid()), { ok: true });
  assert.deepEqual(env.cachePuts.at(-1), { key: 'thr:' + CID, sec: 10 });

  // 같은 판이 아니라 새 판(플레이 시간이 다름)을 연달아 보내는 경우
  env.now += 3000;
  assert.deepEqual(post(env, valid({ playTimeMs: 90001 })), { ok: false, error: 'throttled' });
  env.now += 6000;
  assert.deepEqual(post(env, valid({ playTimeMs: 90002 })), { ok: false, error: 'throttled' });
  assert.equal(env.sheet.rows.length, 2, '막힌 요청은 행을 추가하지 않는다');
  assert.equal(env.lockHeld, false, '막혀도 락을 풀어야 한다');

  env.now += 1001; // 첫 제출로부터 10초 경과
  assert.deepEqual(post(env, valid({ playTimeMs: 90003 })), { ok: true });
  assert.equal(env.sheet.rows.length, 3);
});

// ── 재전송 (응답이 유실된 뒤 같은 판을 다시 보내는 경우) ─────────────

test('재전송: 같은 판을 다시 보내면 성공으로 답하고 행을 늘리지 않는다 (빈도 제한 창 안/밖 모두)', () => {
  const env = createEnv();
  assert.deepEqual(post(env, valid()), { ok: true });
  assert.equal(env.sheet.rows.length, 2);

  env.now += 3000; // 수동 재시도: "너무 자주" 가 아니라 성공이어야 한다 (이미 저장됐으므로)
  assert.deepEqual(post(env, valid()), { ok: true });
  env.now += 20000; // 다음 접속 때 자동 재전송: 빈도 제한 창이 지난 뒤
  assert.deepEqual(post(env, valid()), { ok: true });
  env.now += 3 * 86400000; // 며칠 뒤에도 (캐시는 이미 만료)
  assert.deepEqual(post(env, valid()), { ok: true });

  assert.equal(env.sheet.rows.length, 2, '같은 판이 여러 줄로 쌓이면 안 된다');
  assert.equal(env.lockHeld, false);
  assert.deepEqual(get(env, {}).data.map((r) => r.score), [321]);
});

test('재전송: 캐시가 비어도 시트를 보고 가려낸다', () => {
  const env = createEnv();
  post(env, valid());
  env.cache.clear();
  assert.deepEqual(post(env, valid()), { ok: true });
  assert.equal(env.sheet.rows.length, 2);
});

test('재전송: 닉네임을 고쳐 다시 보내도 같은 판이다 (처음 저장된 닉네임이 남는다)', () => {
  const env = createEnv();
  post(env, valid({ nickname: '처음' }));
  assert.deepEqual(post(env, valid({ nickname: '고친 뒤' })), { ok: true });
  assert.equal(env.sheet.rows.length, 2);
  assert.equal(env.sheet.rows[1][1], '처음');
});

test('재전송: 점수/최고 단계/플레이 시간/드롭 수 중 하나라도 다르면 새 판이다', () => {
  const env = createEnv();
  post(env, valid());
  const others = [{ score: 322 }, { maxLevel: 6 }, { playTimeMs: 90001 }, { drops: 81 }];
  for (const over of others) {
    env.now += 11000; // 빈도 제한 창 밖
    assert.deepEqual(post(env, valid(over)), { ok: true }, JSON.stringify(over));
  }
  assert.equal(env.sheet.rows.length, 2 + others.length);
});

test('재전송: 다른 clientId 의 같은 기록과 clientId 없는 요청은 새 기록이다', () => {
  const env = createEnv();
  post(env, valid());
  assert.deepEqual(post(env, valid({ clientId: 'zyxwvutsrqponmlk9876' })), { ok: true });
  assert.deepEqual(post(env, valid({ clientId: undefined })), { ok: true });
  assert.deepEqual(post(env, valid({ clientId: undefined })), { ok: true });
  assert.equal(env.sheet.rows.length, 5);
});

test('재전송: 숫자 셀로 바뀐 값이나 헤더만 있는 시트에서도 안전하게 동작한다', () => {
  const env = createEnv({ rows: [HEADER, [new Date(1), 'x', '321', '7', '90000', '80', CID]] });
  assert.deepEqual(post(env, valid()), { ok: true }, '문자열로 저장된 숫자도 같은 판으로 본다');
  assert.equal(env.sheet.rows.length, 2);
  const empty = createEnv({ rows: [HEADER] });
  assert.deepEqual(post(empty, valid()), { ok: true });
  assert.equal(empty.sheet.rows.length, 2);
});

test('재전송: 최근 행만 훑는다 (읽는 범위 상한)', () => {
  const rows = [HEADER];
  for (let i = 0; i < 700; i++) rows.push([new Date(i), 'n' + i, 10, 1, 1000 + i, 5, 'otherclient' + String(i).padStart(8, '0')]);
  const env = createEnv({ rows });
  post(env, valid());
  assert.equal(env.sheet.rows.length, 702);
  assert.equal(env.sheet.reads, 1, '700행 전체가 아니라 최근 행만 한 번에 읽는다');
});

test('throttle: 다른 clientId 와 clientId 없는 요청은 막지 않는다', () => {
  const env = createEnv();
  assert.deepEqual(post(env, valid()), { ok: true });
  assert.deepEqual(post(env, valid({ clientId: 'zyxwvutsrqponmlk9876' })), { ok: true });
  assert.deepEqual(post(env, valid({ clientId: undefined })), { ok: true });
  assert.deepEqual(post(env, valid({ clientId: undefined })), { ok: true });
  assert.equal(env.sheet.rows.length, 5);
});

test('throttle: 실패한 제출은 빈도 제한을 소모하지 않는다', () => {
  const env = createEnv();
  assert.deepEqual(post(env, valid({ score: -1 })), { ok: false, error: 'invalid_score' });
  env.lockFails = true;
  assert.deepEqual(post(env, valid()), { ok: false, error: 'server_busy' });
  env.lockFails = false;
  assert.deepEqual(post(env, valid()), { ok: true }, '재시도 버튼이 바로 통해야 한다');
});

test('락 획득 실패는 server_busy 이고 시트/캐시를 건드리지 않는다', () => {
  const env = createEnv({ rows: [HEADER, row(1, 'a', 1)] });
  get(env, {}); // 캐시를 채워 둔다
  env.lockFails = true;
  assert.deepEqual(post(env, valid()), { ok: false, error: 'server_busy' });
  assert.deepEqual(env.lockWaits, [5000]);
  assert.equal(env.sheet.rows.length, 2);
  assert.equal(env.releases, 0, '잡지 못한 락은 풀지 않는다');
  assert.deepEqual(env.cacheRemoves, []);
  assert.equal(env.cache.has('ranking'), true);
});

test('시트 쓰기 중 예외가 나도 락을 풀고 내부 정보 없이 server_busy 로 응답한다', () => {
  const env = createEnv();
  env.sheet.appendError = new Error('Exception: secret internal detail');
  const out = env.gas.doPost({ postData: { contents: JSON.stringify(valid()) } });
  assert.deepEqual(parse(out), { ok: false, error: 'server_busy' });
  assert.doesNotMatch(out.getContent(), /secret|Exception|stack/);
  assert.equal(env.lockHeld, false);
  assert.equal(env.releases, 1);
  assert.equal(env.errors.length, 1);
  assert.match(env.errors[0], /secret internal detail/, '로그에는 남는다');

  // 그 요청은 throttle 을 소모하지 않는다
  env.sheet.appendError = null;
  assert.deepEqual(post(env, valid()), { ok: true });
});

test('SHEET_ID 가 없거나 시트가 없으면 제출은 server_busy', () => {
  for (const env of [createEnv({ sheetId: null }), createEnv({ hasSheet: false })]) {
    assert.deepEqual(post(env, valid()), { ok: false, error: 'server_busy' });
    assert.equal(env.lockHeld, false);
  }
});

// ── setup() ──────────────────────────────────────────────

test('setup: SHEET_ID 저장, scores 시트와 7열 헤더 생성, 헤더 고정, 다음 단계 안내', () => {
  const env = createEnv({ sheetId: null, hasSheet: false });
  env.activeSpreadsheet = env.spreadsheet;
  env.gas.setup();

  assert.equal(env.props.get('SHEET_ID'), SHEET_ID);
  assert.ok(env.sheet, 'scores 시트 생성');
  assert.deepEqual(env.sheet.rows, [HEADER]);
  assert.equal(env.sheet.frozenRows, 1);
  assert.deepEqual(env.sheet.numberFormats, [['B:B', '@']], '닉네임 열은 일반 텍스트');
  assert.equal(env.props.get('NICKNAME_TEXT_FORMAT'), SHEET_ID, '제출 때 같은 서식을 되풀이하지 않도록 표시');
  const log = env.logs.join('\n');
  assert.match(log, new RegExp(SHEET_ID));
  assert.match(log, /웹 앱/);
  assert.match(log, /API_URL/);

  // 설정 직후 바로 동작한다
  assert.deepEqual(post(env, valid()), { ok: true });
  assert.deepEqual(env.sheet.numberFormats, [['B:B', '@']], 'setup 에서 한 서식을 제출이 되풀이하지 않는다');
  assert.deepEqual(env.openedIds, [SHEET_ID]);
  assert.equal(get(env, {}).data[0].nickname, '수박왕');
});

test('setup: 다시 실행해도 기존 데이터와 헤더를 건드리지 않는다', () => {
  const rows = [HEADER, row(1000, 'a', 10), row(2000, 'b', 20)];
  const env = createEnv({ rows });
  env.activeSpreadsheet = env.spreadsheet;
  env.gas.setup();
  env.gas.setup();
  assert.equal(env.sheet.rows.length, 3);
  assert.deepEqual(env.sheet.rows[0], HEADER);
  assert.equal(env.sheet.rows[2][1], 'b');
  assert.equal(env.sheet.frozenRows, 1);
});

test('setup: 예전 6열 헤더는 7열로 고치고, 헤더 없는 시트는 윗줄을 끼운다', () => {
  const old = createEnv({ rows: [HEADER.slice(0, 6), [new Date(1000), 'a', 10, 1, 1, 1]] });
  old.activeSpreadsheet = old.spreadsheet;
  old.gas.setup();
  assert.deepEqual(old.sheet.rows[0], HEADER);
  assert.equal(old.sheet.rows.length, 2);

  const headerless = createEnv({ rows: [[new Date(1000), 'a', 10, 1, 1, 1, '']] });
  headerless.activeSpreadsheet = headerless.spreadsheet;
  headerless.gas.setup();
  assert.deepEqual(headerless.sheet.rows[0], HEADER);
  assert.equal(headerless.sheet.rows[1][1], 'a', '기존 데이터는 아래로 밀릴 뿐 보존된다');
  assert.deepEqual(get(headerless, {}).data.map((r) => r.nickname), ['a']);
});

test('setup: 스프레드시트에 바인딩되지 않았으면 이유를 알려 주며 실패한다', () => {
  const env = createEnv({ sheetId: null });
  env.activeSpreadsheet = null;
  assert.throws(() => env.gas.setup(), /스프레드시트/);
  assert.equal(env.props.has('SHEET_ID'), false);
});

// ── 매니페스트 ───────────────────────────────────────────

test('appsscript.json: V8, Asia/Seoul, 익명 접근 웹 앱(배포자 권한)', () => {
  assert.equal(MANIFEST.runtimeVersion, 'V8');
  assert.equal(MANIFEST.timeZone, 'Asia/Seoul');
  assert.equal(MANIFEST.exceptionLogging, 'STACKDRIVER');
  assert.deepEqual(MANIFEST.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  assert.equal('oauthScopes' in MANIFEST, false, '스코프는 자동 감지에 맡긴다');
});
