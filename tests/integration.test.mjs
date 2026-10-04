// 모듈 사이 계약 검증 (브라우저 없이): 실제 Matter + physics.js + game.js 로 한 판을 끝까지 돌리고,
// 그 결과를 api.js → Code.gs(vm, 모의 Apps Script 서비스) 로 흘려 보내 서버가 받아들이는지 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { WORLD, FRUITS, TIMING, RANKING_LIMIT } from '../js/config.js';
import { createGame } from '../js/game.js';
import { createPhysics } from '../js/physics.js';
import { submitScore, fetchRanking } from '../js/api.js';

const Matter = await import('matter-js').then((m) => m.default ?? m, () => null);
// CI 처럼 의존성이 반드시 있어야 하는 환경에서는 물리 테스트를 조용히 건너뛰지 않고 실패시킨다.
if (!Matter && process.env.CI) throw new Error('matter-js 가 설치되지 않음 (npm ci)');
const skip = Matter ? false : 'matter-js 가 설치되지 않음 (npm install)';
if (Matter) globalThis.Matter = Matter;

const CLIENT_ID = 'integration-client-0001';
const MAX_STEPS = 60 * 60 * 20; // 20분(sim) 안에는 끝나야 한다

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// main.js 의 시뮬레이션 루프와 같은 순서: 물리 스텝 → 규칙 갱신 → 경계선 판정
function playGame(seed) {
  const rng = mulberry32(seed);
  const game = createGame({ rng });
  const physics = createPhysics({ onMerge: (evt) => game.applyMerge(evt) });
  let steps = 0;
  let simTime = 0;
  let escaped = 0;
  game.start(simTime);
  while (game.isPlaying && steps < MAX_STEPS) {
    if (game.state === 'READY') {
      const level = game.drop(simTime);
      const r = FRUITS[level].radius;
      const x = r + rng() * (WORLD.width - 2 * r);
      physics.spawn(level, x, WORLD.spawnY, simTime);
    }
    steps += 1;
    simTime = steps * TIMING.step;
    physics.step(TIMING.step, simTime);
    game.update(simTime);
    const bodies = physics.bodies();
    const items = bodies.map((b) => ({ body: b, y: b.position.y, radius: FRUITS[b.level].radius, bornAt: b.bornAt, overSince: b.overSince }));
    game.checkOverflow(items, simTime);
    // 판정이 갱신한 overSince 는 바디에 되돌려 써야 다음 스텝에 이어진다 (main.js 와 같음)
    for (const it of items) it.body.overSince = it.overSince;
    // 합쳐질 때 눌려 벽에 파고드는 것은 허용하지만 중심이 반지름의 절반보다 깊이 들어가면 안 된다
    for (const b of bodies) {
      const p = b.position;
      const r = FRUITS[b.level].radius * 0.5 - 0.01;
      if (!(p.x >= r && p.x <= WORLD.width - r && p.y <= WORLD.height - r)) escaped += 1;
    }
  }
  return {
    game,
    physics,
    steps,
    escaped,
    payload: {
      nickname: '통합테스트',
      score: game.score,
      maxLevel: game.maxLevel,
      playTimeMs: Math.round(game.playTimeMs(simTime)),
      drops: game.drops,
      clientId: CLIENT_ID,
    },
  };
}

// ── Code.gs 를 vm 에 올린다 (서비스는 최소한의 모의 객체) ──────────────────

function loadBackend() {
  const rows = [['timestamp', 'nickname', 'score', 'maxLevel', 'playTimeMs', 'drops', 'clientId']];
  const cache = new Map();
  const props = new Map();
  const sheet = {
    getLastRow: () => rows.length,
    getRange: (row, col, n, m) =>
      typeof row === 'string'
        ? { setNumberFormat() {} } // 'B:B' 서식 지정
        : { getValues: () => Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => rows[row - 1 + i]?.[col - 1 + j] ?? '')) },
    appendRow: (values) => void rows.push(Array.from(values)),
  };
  const sandbox = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k === 'SHEET_ID' ? 'sheet-id' : props.get(k) ?? null),
        setProperty: (k, v) => void props.set(k, v),
      }),
    },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => cache.get(k) ?? null,
        put: (k, v) => void cache.set(k, v),
        remove: (k) => void cache.delete(k),
      }),
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (text) => ({ getContent: () => text, setMimeType() { return this; } }),
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8'), ctx, { filename: 'Code.gs' });

  // 브라우저의 fetch 대신 doGet/doPost 를 직접 호출하는 fetch 구현
  const fetchImpl = async (url, init = {}) => {
    const out = init.method === 'POST'
      ? ctx.doPost({ postData: { contents: init.body, type: init.headers?.['Content-Type'] } })
      : ctx.doGet({ parameter: Object.fromEntries(new URL(url).searchParams) });
    const body = out.getContent();
    return { ok: true, status: 200, text: async () => body };
  };
  return { rows, fetchImpl, opts: { url: 'https://script.google.com/macros/s/TEST/exec', fetchImpl } };
}

test('완주한 판의 결과를 서버가 받아들이고 랭킹에 나타난다 (여러 시드)', { skip }, async () => {
  for (const seed of [1, 7, 2024, 3]) {
    const backend = loadBackend();
    const run = playGame(seed);
    assert.equal(run.game.state, 'GAME_OVER', `seed ${seed}: ${MAX_STEPS} 스텝 안에 게임오버가 되지 않음`);
    assert.equal(run.escaped, 0, `seed ${seed}: 과일이 벽/바닥에 너무 깊이 파고듦`);
    assert.ok(run.payload.drops >= 20, `seed ${seed}: 너무 일찍 끝남 (drops=${run.payload.drops})`);
    assert.ok(run.payload.playTimeMs >= (run.payload.drops - 1) * 500, 'sim 시간이 쿨다운과 맞지 않음');

    const res = await submitScore(run.payload, backend.opts);
    assert.deepEqual(res, { ok: true }, `seed ${seed}: 서버가 거부 ${JSON.stringify(res)} / ${JSON.stringify(run.payload)}`);
    assert.equal(backend.rows.length, 2);
    assert.equal(backend.rows[1][2], run.payload.score);

    const ranking = await fetchRanking(RANKING_LIMIT, backend.opts);
    assert.equal(ranking.ok, true);
    assert.equal(ranking.data[0].nickname, '통합테스트');
    assert.equal(ranking.data[0].score, run.payload.score);

    // 응답이 유실돼 같은 판을 다시 보내면 성공으로 답하고 행은 늘지 않는다 (재시도/부팅 때 재전송)
    assert.deepEqual(await submitScore(run.payload, backend.opts), { ok: true });
    assert.equal(backend.rows.length, 2, `seed ${seed}: 같은 판이 두 줄로 기록됨`);
    // 다른 판을 같은 clientId 로 곧바로 보내면 서버가 제한한다 (재시도 가능한 오류로 취급됨)
    const next = { ...run.payload, playTimeMs: run.payload.playTimeMs + 1 };
    assert.deepEqual(await submitScore(next, backend.opts), { ok: false, error: 'throttled' });
  }
});

test('같은 시드로 두 번 돌리면 결과가 같다 (고정 타임스텝 → 기기 주사율과 무관)', { skip }, () => {
  const a = playGame(99);
  const b = playGame(99);
  assert.equal(a.payload.score, b.payload.score);
  assert.equal(a.payload.drops, b.payload.drops);
  assert.equal(a.steps, b.steps);
  const pos = (run) => run.physics.bodies().map((x) => [x.level, +x.position.x.toFixed(6), +x.position.y.toFixed(6)]);
  assert.deepEqual(pos(a), pos(b));
});
