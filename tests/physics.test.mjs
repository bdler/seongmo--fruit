// physics.js 단위 테스트: 실제 Matter 로 합치기 규칙(가이드 §5.3)과 안전망을 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WORLD, FRUITS, TIMING, LAST_LEVEL } from '../js/config.js';
import { createPhysics } from '../js/physics.js';

const Matter = await import('matter-js').then((m) => m.default ?? m, () => null);
// CI 처럼 의존성이 반드시 있어야 하는 환경에서는 조용히 건너뛰지 않고 실패시킨다.
if (!Matter && process.env.CI) throw new Error('matter-js 가 설치되지 않음 (npm ci)');
const skip = Matter ? false : 'matter-js 가 설치되지 않음 (npm install)';
if (Matter) globalThis.Matter = Matter;

const STEP = TIMING.step;
const FLOOR = WORLD.height;

function setup() {
  const merges = [];
  const physics = createPhysics({ onMerge: (evt) => merges.push(evt) });
  let steps = 0;
  const run = (n) => {
    for (let i = 0; i < n; i++) {
      steps += 1;
      physics.step(STEP, steps * STEP);
    }
    return steps * STEP;
  };
  return { physics, merges, run, now: () => steps * STEP };
}

const levels = (physics) => physics.bodies().map((b) => b.level).sort((a, b) => a - b);

test('spawn: 과일 바디의 필드와 알 수 없는 단계 처리', { skip }, () => {
  const { physics } = setup();
  const b = physics.spawn(3, 200, 100, 1234);
  assert.equal(b.isFruit, true);
  assert.equal(b.level, 3);
  assert.equal(b.merging, false);
  assert.equal(b.bornAt, 1234);
  assert.equal(b.mergedAt, -Infinity);
  assert.equal(b.overSince, null);
  assert.equal(b.circleRadius, FRUITS[3].radius);
  assert.deepEqual(physics.bodies(), [b]);

  const m = physics.spawn(4, 100, 100, 99, { merged: true, velocity: { x: 1, y: 2 } });
  assert.equal(m.mergedAt, 99);
  assert.deepEqual([m.velocity.x, m.velocity.y], [1, 2]);
  assert.throws(() => physics.spawn(99, 0, 0, 0), RangeError);
});

test('합치기: 같은 단계 한 쌍은 한 단계 위 과일 1개가 되고 이벤트는 한 번', { skip }, () => {
  const { physics, merges, run } = setup();
  const L = 3;
  const r = FRUITS[L].radius;
  physics.spawn(L, 160, FLOOR - r, 0);
  physics.spawn(L, 160 + 2 * r - 2, FLOOR - r, 0);
  const t = run(6);
  assert.deepEqual(levels(physics), [L + 1]);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].level, L + 1);
  assert.equal(merges[0].bonus, false);
  const merged = physics.bodies()[0];
  assert.ok(merged.mergedAt > 0 && merged.mergedAt <= t, 'popAge 계산용 mergedAt 이 기록됨');
  assert.equal(merged.bornAt, merged.mergedAt);
  run(120);
  assert.deepEqual(levels(physics), [L + 1], '시간이 지나도 중복 생성/소멸 없음');
  assert.equal(merges.length, 1);
});

test('합치기: 3개가 한꺼번에 닿으면 2개만 합쳐지고 1개는 남는다', { skip }, () => {
  const { physics, merges, run } = setup();
  const r = FRUITS[2].radius;
  physics.spawn(2, 100, FLOOR - r, 0);
  physics.spawn(2, 100 + 2 * r - 3, FLOOR - r, 0);
  physics.spawn(2, 100 + 2 * (2 * r - 3), FLOOR - r, 0);
  run(6);
  assert.deepEqual(levels(physics), [2, 3]);
  assert.equal(merges.length, 1);
});

test('합치기: 수박 한 쌍은 둘 다 사라지고 보너스 이벤트만 남긴다', { skip }, () => {
  const { physics, merges, run } = setup();
  const r = FRUITS[LAST_LEVEL].radius;
  physics.spawn(LAST_LEVEL, 105, FLOOR - r, 0);
  physics.spawn(LAST_LEVEL, 295, FLOOR - r, 0);
  run(30);
  assert.deepEqual(physics.bodies(), []);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].level, LAST_LEVEL);
  assert.equal(merges[0].bonus, true);
});

test('합치기: 새 과일은 두 과일의 중간 지점에서 속도를 이어받는다 (가이드 §5.3 #4)', { skip }, () => {
  // 위로 던진 두 과일이 나란히 겹쳐 있다: 합쳐질 때 위쪽 속도가 사라지면 안 된다
  const { physics, run } = setup();
  const r = FRUITS[1].radius;
  const a = physics.spawn(1, 150, 300, 0, { velocity: { x: 0, y: -8 } });
  const b = physics.spawn(1, 150 + 2 * r - 2, 300, 0, { velocity: { x: 0, y: -8 } });
  const midX = (a.position.x + b.position.x) / 2;
  run(1);
  const [merged] = physics.bodies();
  assert.equal(physics.bodies().length, 1);
  assert.equal(merged.level, 2);
  assert.ok(Math.abs(merged.position.x - midX) < 2, `중간 지점: ${merged.position.x} vs ${midX}`);
  assert.ok(merged.velocity.y < -6, `속도를 이어받지 못함 vy=${merged.velocity.y}`);

  // 마주 보고 부딪힌 경우: 같은 질량이라 충돌로 운동량이 보존되므로 평균 속도는 (6 + -2) / 2 = 2
  const head = setup();
  head.physics.spawn(1, 150, 300, 0, { velocity: { x: 6, y: 0 } });
  head.physics.spawn(1, 150 + 2 * r - 2, 300, 0, { velocity: { x: -2, y: 0 } });
  head.run(1);
  const [m2] = head.physics.bodies();
  assert.equal(head.physics.bodies().length, 1);
  assert.ok(Math.abs(m2.velocity.x - 2) < 0.3, `평균 속도 vx=${m2.velocity.x}`);
});

test('안전망: 터무니없이 빠른 과일은 매 스텝 최고 속도(40)로 제한된다', { skip }, () => {
  const { physics, run } = setup();
  const b = physics.spawn(0, 200, 50, 0, { velocity: { x: 150, y: 200 } });
  run(1);
  const speed = Math.hypot(b.velocity.x, b.velocity.y);
  assert.ok(speed <= 40 + 1e-6, `속도 ${speed}`);
  assert.ok(speed > 39, '방향은 유지한 채 크기만 줄인다');
  assert.ok(b.velocity.x > 0 && b.velocity.y > 0);
});

test('안전망: 빠르게 떨어뜨려도 바닥/벽을 뚫지 않는다', { skip }, () => {
  const { physics, run } = setup();
  const r = FRUITS[4].radius;
  const b = physics.spawn(4, 200, 50, 0, { velocity: { x: 0, y: 200 } });
  const left = physics.spawn(0, 30, 50, 0, { velocity: { x: -200, y: 0 } });
  const right = physics.spawn(0, 370, 50, 0, { velocity: { x: 200, y: 0 } });
  for (let i = 0; i < 180; i++) {
    run(1);
    for (const body of [b, left, right]) {
      const rr = FRUITS[body.level].radius;
      assert.ok(body.position.x >= rr * 0.5 && body.position.x <= WORLD.width - rr * 0.5, `벽 이탈 x=${body.position.x}`);
      assert.ok(body.position.y <= FLOOR - rr * 0.5, `바닥 이탈 y=${body.position.y}`);
    }
  }
  assert.ok(Math.abs(b.position.y - (FLOOR - r)) < 3, '바닥 위에 정지');
});

test('clear: 모든 과일과 대기 중인 합치기를 지운다', { skip }, () => {
  const { physics, merges, run } = setup();
  const r = FRUITS[2].radius;
  physics.spawn(2, 100, FLOOR - r, 0);
  physics.spawn(2, 100 + 2 * r - 3, FLOOR - r, 0);
  run(1); // 충돌이 감지되어 합치기가 이미 큐에 들어갔거나 처리됨
  const before = merges.length;
  physics.spawn(5, 300, 100, 0);
  physics.clear();
  assert.deepEqual(physics.bodies(), []);
  run(30);
  assert.deepEqual(physics.bodies(), [], 'clear 뒤에 되살아나는 과일이 없다');
  assert.equal(merges.length, before, 'clear 뒤에는 합치기 이벤트가 더 나오지 않는다');
});

test('onMerge 가 던져도 나머지 합치기는 끝까지 처리된다', { skip }, () => {
  const seen = [];
  const physics = createPhysics({
    onMerge: (evt) => {
      seen.push(evt.level);
      if (seen.length === 1) throw new Error('callback failed');
    },
  });
  const r = FRUITS[1].radius;
  physics.spawn(1, 60, FLOOR - r, 0);
  physics.spawn(1, 60 + 2 * r - 2, FLOOR - r, 0);
  physics.spawn(1, 300, FLOOR - r, 0);
  physics.spawn(1, 300 + 2 * r - 2, FLOOR - r, 0);
  assert.throws(() => physics.step(STEP, STEP), /callback failed/);
  assert.equal(seen.length, 2, '두 쌍 모두 처리');
  assert.deepEqual(physics.bodies().map((b) => b.level), [2, 2]);
  assert.ok(physics.bodies().every((b) => b.merging === false));
});
