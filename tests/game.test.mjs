import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WORLD,
  LAST_LEVEL,
  MAX_DROP_LEVEL,
  DROP_WEIGHTS,
  TIMING,
  scoreOf,
  WATERMELON_PAIR_BONUS,
} from '../js/config.js';
import { createGame, pickDropLevel, evaluateOverflow, STATES } from '../js/game.js';

// 값을 순서대로 돌려주고, 다 쓰면 마지막 값을 반복하는 rng
const seq = (...values) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

// 재현 가능한 의사 난수 (LCG)
const lcg = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

// 경계선 위에 걸친 과일(top = y - radius < dangerY)과 그 아래 과일
const above = (bornAt, extra = {}) => ({ y: WORLD.dangerY + 10, radius: 30, bornAt, overSince: null, ...extra });
const below = (bornAt, extra = {}) => ({ y: 400, radius: 30, bornAt, overSince: null, ...extra });

const startedGame = (opts) => {
  const game = createGame(opts);
  game.start(0);
  return game;
};

test('점수표: 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66', () => {
  const expected = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66];
  assert.deepEqual(Array.from({ length: LAST_LEVEL + 1 }, (_, l) => scoreOf(l)), expected);

  const game = startedGame();
  for (let level = 1; level <= LAST_LEVEL; level++) {
    const before = game.score;
    const points = game.applyMerge({ level, x: 0, y: 0, bonus: false });
    assert.equal(points, expected[level]);
    assert.equal(game.score - before, expected[level]);
  }
});

test('수박 쌍은 보너스 점수만 주고 maxLevel 은 수박이 된다', () => {
  const game = startedGame();
  const points = game.applyMerge({ level: LAST_LEVEL, x: 0, y: 0, bonus: true });
  assert.equal(points, WATERMELON_PAIR_BONUS);
  assert.equal(game.score, WATERMELON_PAIR_BONUS);
  assert.equal(game.maxLevel, LAST_LEVEL);
});

test('가중치: 경계값에서 정확한 단계를 고른다', () => {
  assert.equal(DROP_WEIGHTS.length, MAX_DROP_LEVEL + 1);
  const total = DROP_WEIGHTS.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let level = 0; level < DROP_WEIGHTS.length; level++) {
    const lo = acc / total;
    acc += DROP_WEIGHTS[level];
    const hi = acc / total;
    assert.equal(pickDropLevel(() => lo + 1e-9), level, `lo of ${level}`);
    assert.equal(pickDropLevel(() => hi - 1e-9), level, `hi of ${level}`);
  }
  assert.equal(pickDropLevel(() => 0), 0);
  assert.equal(pickDropLevel(() => 0.999999), MAX_DROP_LEVEL);
  assert.equal(pickDropLevel(() => 1), MAX_DROP_LEVEL, 'rng()==1 이어도 범위를 넘지 않는다');
});

test('가중치: 분포가 DROP_WEIGHTS 비율을 따르고 Lv0~4 밖은 나오지 않는다', () => {
  const rng = lcg(42);
  const n = 100000;
  const counts = new Array(DROP_WEIGHTS.length).fill(0);
  for (let i = 0; i < n; i++) {
    const level = pickDropLevel(rng);
    assert.ok(Number.isInteger(level) && level >= 0 && level <= MAX_DROP_LEVEL);
    counts[level] += 1;
  }
  const total = DROP_WEIGHTS.reduce((a, b) => a + b, 0);
  DROP_WEIGHTS.forEach((w, level) => {
    const expected = w / total;
    assert.ok(Math.abs(counts[level] / n - expected) < 0.01, `level ${level}: ${counts[level] / n} vs ${expected}`);
  });
});

test('가중치: 사용자 지정 가중치와 0 가중치', () => {
  assert.equal(pickDropLevel(() => 0.5, [0, 1, 0]), 1);
  assert.equal(pickDropLevel(() => 0, [0, 1, 0]), 1);
  assert.equal(pickDropLevel(() => 0.999, [0, 1, 0]), 1);
});

test('start: IDLE → READY, rng 로 현재/다음 과일을 뽑는다', () => {
  const game = createGame({ rng: seq(0, 0.999) });
  assert.equal(game.state, STATES.IDLE);
  assert.equal(game.current, null);
  game.start(123);
  assert.equal(game.state, 'READY');
  assert.equal(game.current, 0);
  assert.equal(game.next, MAX_DROP_LEVEL);
  assert.equal(game.playTimeMs(123), 0);
});

test('drop: READY 에서만 되고, 현재/다음 과일이 이어진다', () => {
  const game = createGame({ rng: seq(0, 0.5, 0.999, 0) }); // current=0, next=1(0.5→28 구간), 이후 4, 0
  assert.equal(game.drop(0), null, 'IDLE 에서는 드롭 불가');
  game.start(0);
  const cur = game.current;
  const nxt = game.next;
  assert.equal(game.drop(100), cur);
  assert.equal(game.current, nxt, '다음 과일이 현재가 된다');
  assert.equal(game.drops, 1);
  assert.equal(game.state, 'COOLDOWN');
  assert.equal(game.drop(101), null, '쿨다운 중 입력 무시');
  assert.equal(game.drops, 1);
});

test('쿨다운: 정확히 dropCooldown 이 지나야 READY (경계값)', () => {
  const game = startedGame();
  game.drop(1000);
  assert.equal(game.cooldownUntil, 1000 + TIMING.dropCooldown);
  assert.equal(game.update(1000 + TIMING.dropCooldown - 1), 'COOLDOWN');
  assert.equal(game.update(1000 + TIMING.dropCooldown), 'READY');
  assert.ok(game.drop(1000 + TIMING.dropCooldown) !== null);
});

test('쿨다운: 고정 스텝(부동소수점 누적)으로도 30스텝 뒤 READY', () => {
  const game = startedGame();
  let steps = 0;
  game.drop(0);
  const steps500 = Math.round(TIMING.dropCooldown / TIMING.step);
  for (let i = 0; i < steps500 - 1; i++) {
    steps += 1;
    assert.equal(game.update(steps * TIMING.step), 'COOLDOWN');
  }
  steps += 1;
  assert.equal(game.update(steps * TIMING.step), 'READY');
  // 누적 덧셈으로 시간을 쌓아도 같은 결과여야 한다
  const game2 = startedGame();
  game2.drop(0);
  let t = 0;
  for (let i = 0; i < steps500; i++) {
    t += TIMING.step;
    game2.update(t);
  }
  assert.equal(game2.state, 'READY');
});

test('쿨다운 중이 아닌 update 는 상태를 바꾸지 않는다', () => {
  const game = createGame();
  assert.equal(game.update(10000), 'IDLE');
  game.start(0);
  assert.equal(game.update(10000), 'READY');
});

test('maxLevel: 합치기로 올라가고 내려가지 않는다 (드롭 단계도 반영)', () => {
  const game = startedGame({ rng: seq(0) }); // 항상 Lv0
  assert.equal(game.maxLevel, 0);
  game.applyMerge({ level: 3, x: 0, y: 0, bonus: false });
  assert.equal(game.maxLevel, 3);
  game.applyMerge({ level: 2, x: 0, y: 0, bonus: false });
  assert.equal(game.maxLevel, 3, '낮은 단계 합치기로 줄지 않는다');

  const g2 = startedGame({ rng: seq(0.999) }); // 항상 Lv4
  g2.drop(0);
  assert.equal(g2.maxLevel, MAX_DROP_LEVEL);
});

test('cleared: 첫 수박 생성 시 한 번만 true (일회성)', () => {
  const game = startedGame();
  assert.equal(game.cleared, false);
  game.applyMerge({ level: LAST_LEVEL - 1, x: 0, y: 0, bonus: false });
  assert.equal(game.cleared, false);
  game.applyMerge({ level: LAST_LEVEL, x: 0, y: 0, bonus: false });
  assert.equal(game.cleared, true);
  // 이후 다시 수박이 만들어져도 '새로 true 가 되는' 일은 없다 (main 이 전이를 한 번만 감지)
  const transitions = [];
  for (let i = 0; i < 3; i++) {
    const was = game.cleared;
    game.applyMerge({ level: LAST_LEVEL, x: 0, y: 0, bonus: false });
    transitions.push(!was && game.cleared);
  }
  assert.deepEqual(transitions, [false, false, false]);
  // 게임은 계속된다
  assert.ok(game.isPlaying);
});

test('applyMerge: 게임 중이 아니면 점수를 올리지 않는다', () => {
  const game = createGame();
  assert.equal(game.applyMerge({ level: 3, x: 0, y: 0, bonus: false }), 0);
  assert.equal(game.score, 0);
  game.start(0);
  game.endGame(10);
  assert.equal(game.applyMerge({ level: 3, x: 0, y: 0, bonus: false }), 0);
  assert.equal(game.score, 0);
});

test('overflow: 드롭 유예 안의 과일은 무시되고 타이머가 리셋된다', () => {
  const item = above(0);
  const young = evaluateOverflow([item], TIMING.settleGrace - 1);
  assert.deepEqual(young, { danger: 0, over: false });
  assert.equal(item.overSince, null);

  // 유예가 막 끝난 시점에 비로소 체류가 시작된다
  const t0 = TIMING.settleGrace;
  assert.deepEqual(evaluateOverflow([item], t0), { danger: 0, over: false });
  assert.equal(item.overSince, t0);
});

test('overflow: 체류 시간이 정확히 overflow 일 때 게임오버 (경계값)', () => {
  const item = above(0);
  const t0 = TIMING.settleGrace;
  evaluateOverflow([item], t0);
  const almost = evaluateOverflow([item], t0 + TIMING.overflow - 1);
  assert.equal(almost.over, false);
  assert.ok(almost.danger > 0.99 && almost.danger < 1);
  const done = evaluateOverflow([item], t0 + TIMING.overflow);
  assert.equal(done.over, true);
  assert.equal(done.danger, 1);
});

test('overflow: 경계선 아래로 내려가면 타이머가 리셋되고 연속 시간만 센다', () => {
  const item = above(0);
  const t0 = TIMING.settleGrace;
  evaluateOverflow([item], t0);
  evaluateOverflow([item], t0 + 1500);
  assert.equal(item.overSince, t0);

  item.y = 400; // 내려감
  assert.deepEqual(evaluateOverflow([item], t0 + 1600), { danger: 0, over: false });
  assert.equal(item.overSince, null);

  item.y = WORLD.dangerY + 10; // 다시 올라옴: 새로 시작
  const t1 = t0 + 1700;
  assert.deepEqual(evaluateOverflow([item], t1), { danger: 0, over: false });
  assert.equal(evaluateOverflow([item], t1 + TIMING.overflow - 1).over, false);
  assert.equal(evaluateOverflow([item], t1 + TIMING.overflow).over, true);
});

test('overflow: 경계선에 정확히 닿은 과일(top == dangerY)은 넘은 것이 아니다', () => {
  const item = { y: WORLD.dangerY + 30, radius: 30, bornAt: 0, overSince: null };
  assert.deepEqual(evaluateOverflow([item], 10000), { danger: 0, over: false });
  assert.equal(item.overSince, null);
});

test('overflow: danger 는 과일 중 최댓값이고 [0,1] 범위', () => {
  const a = above(0, { overSince: 3000 });
  const b = above(0, { overSince: 3500 });
  const c = below(0);
  const res = evaluateOverflow([a, b, c], 4000);
  assert.equal(res.danger, (4000 - 3000) / TIMING.overflow); // 0.5
  assert.equal(res.over, false);
  const way = evaluateOverflow([above(0, { overSince: 0 })], 100000);
  assert.equal(way.danger, 1);
  assert.deepEqual(evaluateOverflow([], 5000), { danger: 0, over: false });
});

test('overflow: 새로 합쳐진 과일(bornAt 갱신)은 다시 유예를 받는다', () => {
  const item = above(0, { overSince: 2000 });
  item.bornAt = 4000; // 합쳐져 새로 태어남
  assert.equal(evaluateOverflow([item], 4500).danger, 0);
  assert.equal(item.overSince, null);
});

test('checkOverflow: 게임오버가 되면 GAME_OVER 로 전이하고 이후엔 no-op', () => {
  const game = startedGame();
  const item = above(0);
  const t0 = TIMING.settleGrace;
  assert.equal(game.checkOverflow([item], t0), false);
  assert.equal(game.danger, 0);
  assert.equal(game.checkOverflow([item], t0 + TIMING.overflow / 2), false);
  assert.equal(game.danger, 0.5);
  assert.equal(game.state, 'READY');
  assert.equal(game.checkOverflow([item], t0 + TIMING.overflow), true);
  assert.equal(game.state, 'GAME_OVER');
  assert.equal(game.danger, 1);
  assert.equal(game.checkOverflow([item], t0 + TIMING.overflow + 100), false, '이미 끝난 판');
  assert.equal(game.drop(t0 + 5000), null, '게임오버 후 드롭 불가');
});

test('checkOverflow: 쿨다운 중에도 판정한다', () => {
  const game = startedGame();
  game.drop(0);
  assert.equal(game.state, 'COOLDOWN');
  const item = above(0, { overSince: 0 });
  assert.equal(game.checkOverflow([item], TIMING.settleGrace + TIMING.overflow), true);
  assert.equal(game.state, 'GAME_OVER');
});

test('checkOverflow: 게임 중이 아니면(IDLE) 판정하지 않는다', () => {
  const game = createGame();
  assert.equal(game.checkOverflow([above(0, { overSince: 0 })], 99999), false);
  assert.equal(game.state, 'IDLE');
});

test('playTimeMs: 시뮬레이션 시간으로 세고, 게임오버 시점에서 멈춘다', () => {
  const game = createGame();
  assert.equal(game.playTimeMs(500), 0);
  game.start(1000);
  assert.equal(game.playTimeMs(1000), 0);
  assert.equal(game.playTimeMs(4000), 3000);
  game.endGame(6000);
  assert.equal(game.state, 'GAME_OVER');
  assert.equal(game.playTimeMs(60000), 5000, '끝난 뒤에는 늘어나지 않는다');
  game.endGame(9000);
  assert.equal(game.playTimeMs(60000), 5000, '두 번 끝내도 처음 시점 유지');
});

test('reset/start: 이전 판의 상태가 하나도 남지 않는다', () => {
  const game = createGame({ rng: seq(0.999, 0.999, 0) });
  game.start(0);
  game.drop(0);
  game.applyMerge({ level: LAST_LEVEL, x: 0, y: 0, bonus: false });
  game.applyMerge({ level: LAST_LEVEL, x: 0, y: 0, bonus: true });
  game.checkOverflow([above(0, { overSince: 0 })], 5000);
  game.endGame(5000);
  assert.equal(game.state, 'GAME_OVER');
  assert.ok(game.score > 0 && game.cleared && game.drops === 1 && game.danger === 1);

  game.reset();
  assert.equal(game.state, 'IDLE');
  assert.equal(game.score, 0);
  assert.equal(game.maxLevel, 0);
  assert.equal(game.drops, 0);
  assert.equal(game.cleared, false);
  assert.equal(game.current, null);
  assert.equal(game.next, null);
  assert.equal(game.danger, 0);
  assert.equal(game.cooldownUntil, 0);
  assert.equal(game.playTimeMs(99999), 0);

  // 게임오버 직후 바로 start 해도 동일
  const g2 = createGame({ rng: seq(0) });
  g2.start(0);
  g2.drop(0);
  g2.applyMerge({ level: 5, x: 0, y: 0, bonus: false });
  g2.checkOverflow([above(0, { overSince: 0 })], 9000);
  g2.start(20000);
  assert.equal(g2.state, 'READY');
  assert.equal(g2.score, 0);
  assert.equal(g2.maxLevel, 0);
  assert.equal(g2.drops, 0);
  assert.equal(g2.cleared, false);
  assert.equal(g2.danger, 0);
  assert.equal(g2.playTimeMs(20000), 0);
  assert.equal(g2.drop(20000), 0, '쿨다운도 초기화되어 곧바로 드롭 가능');
});

test('통합 시나리오: 드롭 → 쿨다운 → 재드롭 → 넘침 → 게임오버', () => {
  const game = createGame({ rng: lcg(7) });
  let simTime = 0;
  game.start(simTime);
  const step = () => {
    simTime += TIMING.step;
    game.update(simTime);
  };
  assert.ok(game.drop(simTime) !== null);
  for (let i = 0; i < 29; i++) step();
  assert.equal(game.state, 'COOLDOWN');
  step();
  assert.equal(game.state, 'READY');
  game.drop(simTime);
  assert.equal(game.drops, 2);

  const item = { y: 60, radius: 30, bornAt: simTime, overSince: null };
  let over = false;
  let guard = 0;
  while (!over && guard++ < 1000) {
    step();
    over = game.checkOverflow([item], simTime);
  }
  const expectedSteps = Math.round((TIMING.settleGrace + TIMING.overflow) / TIMING.step);
  assert.ok(over);
  assert.ok(Math.abs(guard - expectedSteps) <= 1, `게임오버까지 ${guard}스텝 (기대 ${expectedSteps})`);
  assert.equal(game.state, 'GAME_OVER');
});
