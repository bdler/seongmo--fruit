// render.js 단위 테스트 (브라우저 없이). 순수 함수(popScale, shade)와, 가짜 2D 컨텍스트에 남은 그리기 호출로
// 경계선 경고/이펙트/모션 줄이기 동작을 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WORLD } from '../js/config.js';
import { createRenderer, popScale, shade } from '../js/render.js';

// ── 가짜 캔버스 ──────────────────────────────────────────

// 모든 메서드 호출을 기록하고, 속성 대입은 상태로 보관하는 2D 컨텍스트.
// 호출 시점의 스타일/변환을 함께 남겨서 '그때 무슨 색, 어느 크기로 그렸나'를 볼 수 있다.
function fakeCtx(log) {
  const state = { transform: [1, 0, 0, 1, 0, 0] };
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(_, key) {
      if (key in state) return state[key];
      if (key === 'measureText') return () => ({ actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 0 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
      return (...args) => {
        if (key === 'setTransform') state.transform = args;
        log.push({
          fn: String(key),
          args,
          transform: state.transform,
          strokeStyle: state.strokeStyle,
          lineWidth: state.lineWidth,
          fillStyle: state.fillStyle,
        });
      };
    },
    set(_, key, value) {
      state[key] = value;
      return true;
    },
  });
}

function fakeCanvas(w, h, log = []) {
  const ctx = fakeCtx(log);
  return {
    width: w,
    height: h,
    clientWidth: w,
    clientHeight: h,
    getContext: () => ctx,
  };
}

// matchMedia/document 전역을 심고 렌더러를 만든다. 반환값의 log 는 게임 캔버스에만 그려진 호출이다.
function setup({ reduced = false } = {}) {
  const listeners = [];
  globalThis.matchMedia = (query) => {
    assert.match(query, /prefers-reduced-motion/);
    return { matches: reduced, addEventListener: (type, fn) => type === 'change' && listeners.push(fn) };
  };
  globalThis.document = { createElement: () => fakeCanvas(8, 8) }; // 배경/스프라이트용 오프스크린
  const log = [];
  const renderer = createRenderer(fakeCanvas(400, 600, log), fakeCanvas(64, 64));
  const env = {
    renderer,
    log,
    setReduced: (matches) => listeners.forEach((fn) => fn({ matches })),
    frame: (over = {}) => renderer.draw({ now: 0, time: 0, state: 'READY', bodies: [], held: null, danger: 0, ...over }),
    drain: () => log.splice(0),
    take: (fn) => log.splice(0).filter((c) => c.fn === fn),
  };
  env.frame(); // 첫 프레임은 캔버스 크기 설정(resize)을 함께 하므로 미리 돌려 둔다
  log.length = 0;
  return env;
}

function teardown() {
  delete globalThis.matchMedia;
  delete globalThis.document;
}

const withEnv = (opts, fn) => async () => {
  const env = setup(opts);
  try {
    await fn(env);
  } finally {
    teardown();
  }
};

// 아무 과일/이펙트도 없는 프레임에서 게임 캔버스에 stroke 된 것은 경계선뿐이다.
function dangerStroke(env, danger, now) {
  env.log.length = 0;
  env.frame({ danger, now });
  const strokes = env.take('stroke');
  assert.equal(strokes.length, 1, '경계선 하나만 stroke 되어야 함');
  return strokes[0];
}

const RED = /^rgba\(229,57,53,/;

// ── popScale / shade ─────────────────────────────────────

test('popScale: 0.8 → 1.12 → 1.0 으로 튀고, 끝난 뒤/잘못된 값은 1', () => {
  assert.equal(popScale(0), 0.8);
  assert.ok(Math.abs(popScale(90) - 1.12) < 1e-9, `정점 ${popScale(90)}`);
  assert.ok(popScale(45) > 0.8 && popScale(45) < 1.12);
  assert.ok(popScale(135) > 1 && popScale(135) < 1.12);
  assert.ok(Math.abs(popScale(179.9) - 1) < 0.01, '끝 직전에는 거의 1');
  for (const age of [180, 181, 5000, Infinity, NaN, undefined, 'x']) {
    assert.equal(popScale(age), 1, `age=${String(age)}`);
  }
  assert.equal(popScale(-5), 0.8, '음수 나이는 시작값으로 취급');
  // 정점을 넘지 않고 0.8 아래로 내려가지 않는다
  for (let a = 0; a < 180; a += 3) {
    const k = popScale(a);
    assert.ok(k >= 0.8 - 1e-9 && k <= 1.12 + 1e-9, `age=${a} → ${k}`);
  }
});

test('shade: 흰색/검정 쪽으로 섞고, 해석 못 하는 색은 그대로', () => {
  assert.equal(shade('#000000', 0.5), 'rgb(128,128,128)');
  assert.equal(shade('#ffffff', -0.5), 'rgb(128,128,128)');
  assert.equal(shade('#ff0000', 0), 'rgb(255,0,0)');
  assert.equal(shade('#f00', 0), 'rgb(255,0,0)', '3자리 hex');
  assert.equal(shade('#336699', 2), 'rgb(255,255,255)', '비율은 1 로 제한');
  assert.equal(shade('#336699', -2), 'rgb(0,0,0)');
  assert.equal(shade('tomato', 0.3), 'tomato');
});

// ── 경계선 경고 (가이드 §6.4: 체류 시간의 50% 부터 붉게 깜빡임) ──────

test('경계선: danger 0.5 미만은 중립색, 0.5 이상은 붉은색', withEnv({}, (env) => {
  const calm = dangerStroke(env, 0.49, 0);
  assert.equal(calm.strokeStyle, 'rgba(150,105,60,0.5)');
  assert.equal(calm.lineWidth, 2);
  assert.deepEqual(calm.args, []);

  const warn = dangerStroke(env, 0.5, 0);
  assert.match(warn.strokeStyle, RED);
  assert.ok(warn.lineWidth >= 2);
  // 높을수록 굵어진다
  const worst = dangerStroke(env, 1, 1000 / 12);
  assert.match(worst.strokeStyle, RED);
  assert.ok(worst.lineWidth > warn.lineWidth);
}));

test('경계선: 기본 설정에서는 3Hz 로 깜빡인다', withEnv({}, (env) => {
  const alphaAt = (now) => Number(/,([\d.]+)\)$/.exec(dangerStroke(env, 0.8, now).strokeStyle)[1]);
  const high = alphaAt(1000 / 12); // 3Hz 의 주기는 1000/3 ms: 1/4 주기에서 sin = +1
  const low = alphaAt(250); // 3/4 주기에서 sin = -1
  assert.ok(high > low + 0.3, `깜빡임 폭 ${low} ~ ${high}`);
  assert.ok(Math.abs(alphaAt(0) - alphaAt(1000 / 3)) < 1e-9, '주기는 1/3 초');
}));

test('모션 줄이기: 경계선은 깜빡이지 않고 고정된 강조로 보인다', withEnv({ reduced: true }, (env) => {
  const first = dangerStroke(env, 0.8, 0);
  assert.match(first.strokeStyle, RED, '경고 자체는 계속 보여야 함');
  for (const now of [10, 41.6, 83.3, 125, 250, 333.3, 1234]) {
    const s = dangerStroke(env, 0.8, now);
    assert.equal(s.strokeStyle, first.strokeStyle, `now=${now}`);
    assert.equal(s.lineWidth, first.lineWidth, `now=${now}`);
  }
  // 위험이 커지면 정적이어도 더 강하게 표시된다
  assert.ok(dangerStroke(env, 1, 0).lineWidth > first.lineWidth);
}));

// ── 과일 튀기 (popScale 적용) ─────────────────────────────

// 과일 스프라이트(몸체/음영)를 그릴 때의 변환 배율 a. 첫 drawImage 는 배경이다.
function fruitScales(env, body) {
  env.log.length = 0;
  env.frame({ bodies: [body] });
  return env.take('drawImage').slice(1).map((c) => c.transform[0]);
}

test('과일 튀기: 합쳐진 직후에는 커졌다 줄고, 모션 줄이기에서는 항상 1배', withEnv({}, (env) => {
  const body = { x: 200, y: 300, angle: 0, level: 2, popAge: 90 };
  const peak = fruitScales(env, body);
  assert.ok(peak.length >= 2 && peak.every((k) => Math.abs(k - 1.12) < 1e-9), `정점 ${peak}`);
  assert.deepEqual(fruitScales(env, { ...body, popAge: Infinity }), [1, 1]);

  env.setReduced(true);
  assert.deepEqual(fruitScales(env, body), [1, 1], '모션 줄이기 중에는 튀지 않음');
  env.setReduced(false);
  assert.ok(fruitScales(env, body).every((k) => Math.abs(k - 1.12) < 1e-9), '설정을 끄면 다시 튐');
}));

// ── 이펙트 (파티클/링/점수 글자) ──────────────────────────

function drawEffectFrames(env, nows) {
  return nows.map((now) => {
    env.log.length = 0;
    env.frame({ now });
    const calls = env.drain();
    return { arcs: calls.filter((c) => c.fn === 'arc').length, texts: calls.filter((c) => c.fn === 'fillText') };
  });
}

test('이펙트: 합치기/드롭은 파티클과 링을 그린다 (기본)', withEnv({}, (env) => {
  env.renderer.addMergeEffect({ x: 200, y: 300, level: 3, bonus: false, points: 10 });
  env.renderer.addDropEffect({ x: 100, y: WORLD.spawnY, level: 1 });
  const [a] = drawEffectFrames(env, [0]);
  assert.ok(a.arcs > 10, `원호 ${a.arcs}`);
  assert.equal(a.texts.length, 1);
  assert.equal(a.texts[0].args[0], '+10');
}));

test('모션 줄이기: 파티클/링/드롭 이펙트는 없고, 점수 글자는 제자리에 보인다', withEnv({ reduced: true }, (env) => {
  env.renderer.addMergeEffect({ x: 200, y: 300, level: 3, bonus: false, points: 10 });
  env.renderer.addMergeEffect({ x: 200, y: 300, level: 10, bonus: true, points: 100 });
  env.renderer.addDropEffect({ x: 100, y: WORLD.spawnY, level: 1 });
  const frames = drawEffectFrames(env, [0, 100, 400]);
  for (const f of frames) assert.equal(f.arcs, 0, '원호(파티클/링)가 그려짐');
  assert.deepEqual(frames[0].texts.map((t) => t.args[0]), ['+10', '+100'], '점수 정보는 남는다');
  // 떠오르거나 커지지 않는다: 같은 글자의 변환(위치/배율)이 프레임마다 같다
  for (let i = 1; i < frames.length; i++) {
    assert.deepEqual(frames[i].texts.map((t) => t.transform), frames[0].texts.map((t) => t.transform));
  }
}));

test('이펙트: 모션 줄이기는 실행 중에 바뀌어도 반영된다', withEnv({}, (env) => {
  env.renderer.addMergeEffect({ x: 200, y: 300, level: 3, bonus: false, points: 10 });
  assert.ok(drawEffectFrames(env, [0])[0].arcs > 0);
  env.setReduced(true); // 이미 떠 있던 파티클/링도 치운다
  assert.equal(drawEffectFrames(env, [50])[0].arcs, 0);
  env.renderer.addMergeEffect({ x: 200, y: 300, level: 3, bonus: false, points: 10 });
  assert.equal(drawEffectFrames(env, [60])[0].arcs, 0);
  env.setReduced(false);
  env.renderer.addDropEffect({ x: 100, y: WORLD.spawnY, level: 1 });
  assert.ok(drawEffectFrames(env, [70])[0].arcs > 0);
}));

test('matchMedia 가 없거나 던져도 렌더러는 기본 모션으로 동작한다', async () => {
  delete globalThis.matchMedia;
  globalThis.document = { createElement: () => fakeCanvas(8, 8) };
  try {
    const log = [];
    const r = createRenderer(fakeCanvas(400, 600, log), fakeCanvas(64, 64));
    r.addDropEffect({ x: 100, y: 50, level: 1 });
    r.draw({ now: 0, state: 'READY', bodies: [], held: null, danger: 0 });
    assert.ok(log.some((c) => c.fn === 'arc'));

    globalThis.matchMedia = () => {
      throw new Error('boom');
    };
    const log2 = [];
    const r2 = createRenderer(fakeCanvas(400, 600, log2), fakeCanvas(64, 64));
    r2.addDropEffect({ x: 100, y: 50, level: 1 });
    r2.draw({ now: 0, state: 'READY', bodies: [], held: null, danger: 0 });
    assert.ok(log2.some((c) => c.fn === 'arc'));
  } finally {
    teardown();
  }
});
