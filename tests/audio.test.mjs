import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAudio } from '../js/audio.js';

const NAMES = ['drop', 'merge', 'clear', 'gameover', 'click'];
const flush = () => new Promise((resolve) => setImmediate(resolve));

// 실제 Web Audio 가 던지는 오류(지수 램프 0 이하, start 전 stop 등)를 흉내 내서
// 브라우저에서만 터질 호출을 Node 테스트에서 잡는다.
class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }
  _push(type, v, t) {
    assert.ok(Number.isFinite(v), `param value must be finite (${type} ${v})`);
    assert.ok(Number.isFinite(t) && t >= 0, `param time must be finite (${type} ${t})`);
    this.events.push({ type, v, t });
    return this;
  }
  setValueAtTime(v, t) {
    return this._push('set', v, t);
  }
  linearRampToValueAtTime(v, t) {
    return this._push('linear', v, t);
  }
  exponentialRampToValueAtTime(v, t) {
    if (!(v > 0)) throw new RangeError('exponential ramp target must be > 0');
    return this._push('exp', v, t);
  }
  get last() {
    return this.events[this.events.length - 1];
  }
}

class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.connections = [];
    this.disconnected = false;
  }
  connect(node) {
    this.connections.push(node);
    return node;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeOsc extends FakeNode {
  constructor(ctx) {
    super(ctx, 'osc');
    this.type = 'sine';
    this.frequency = new FakeParam(440);
    this.createdAt = ctx.currentTime;
    this.startTime = null;
    this.stopTimes = [];
    this.ended = false;
    this.onended = null;
  }
  start(t = 0) {
    if (this.startTime !== null) throw new Error('InvalidStateError: start twice');
    this.startTime = t;
  }
  stop(t = this.ctx.currentTime) {
    if (this.startTime === null) throw new Error('InvalidStateError: stop before start');
    this.stopTimes.push(t);
  }
  get stopTime() {
    return this.stopTimes.length ? this.stopTimes[this.stopTimes.length - 1] : Infinity;
  }
}

// opts: state(초기 상태), resume('resolve'|'reject'|'never'), throwOnConstruct, fireEnded
function installFake(t, opts = {}) {
  const log = { contexts: [] };
  const fireEnded = opts.fireEnded !== false;

  class FakeAudioContext {
    constructor() {
      if (opts.throwOnConstruct) throw new Error('NotAllowedError');
      this.currentTime = 0;
      this.state = opts.state ?? 'suspended';
      this.destination = new FakeNode(this, 'destination');
      this.oscillators = [];
      this.gains = [];
      this.resumeCalls = 0;
      this.closed = false;
      log.contexts.push(this);
    }
    createOscillator() {
      const o = new FakeOsc(this);
      this.oscillators.push(o);
      return o;
    }
    createGain() {
      const g = new FakeNode(this, 'gain');
      g.gain = new FakeParam(1);
      this.gains.push(g);
      return g;
    }
    createDynamicsCompressor() {
      const c = new FakeNode(this, 'compressor');
      for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) c[k] = new FakeParam(0);
      return c;
    }
    resume() {
      this.resumeCalls += 1;
      if (opts.resume === 'reject') return Promise.reject(new Error('blocked'));
      if (opts.resume === 'never') return new Promise(() => {});
      return Promise.resolve().then(() => {
        this.state = 'running';
      });
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
    // 오디오 시계를 앞으로 보내고, 끝난 오실레이터의 onended 를 호출한다.
    advance(sec) {
      this.currentTime += sec;
      if (!fireEnded) return;
      for (const o of this.oscillators) {
        if (!o.ended && o.stopTime <= this.currentTime) {
          o.ended = true;
          if (typeof o.onended === 'function') o.onended();
        }
      }
    }
  }

  const saved = {
    AudioContext: globalThis.AudioContext,
    webkitAudioContext: globalThis.webkitAudioContext,
  };
  delete globalThis.webkitAudioContext;
  if (opts.webkitOnly) {
    delete globalThis.AudioContext;
    globalThis.webkitAudioContext = FakeAudioContext;
  } else {
    globalThis.AudioContext = FakeAudioContext;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  });

  return {
    contexts: log.contexts,
    get ctx() {
      return log.contexts[0];
    },
  };
}

function removeAudioContext(t) {
  const saved = {
    AudioContext: globalThis.AudioContext,
    webkitAudioContext: globalThis.webkitAudioContext,
  };
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) globalThis[k] = v;
  });
}

// unlock 하고 resume 이 끝날 때까지 기다린 오디오 (state: running)
async function readyAudio(t, opts) {
  const fake = installFake(t, opts);
  const audio = createAudio();
  audio.unlock();
  await flush();
  return { audio, ctx: fake.ctx, fake };
}

const masterGain = (ctx) =>
  ctx.gains.find((g) =>
    g.connections.some((c) => c === ctx.destination || c.kind === 'compressor'),
  );

// 오실레이터 → 엔벨로프 게인 → 보이스 출력 게인
const voiceOutOf = (osc) => osc.connections[0].connections[0];
const isFading = (out) => out.gain.events.some((e) => e.type === 'linear' && e.v === 0);

// 아직 소리가 남아 있고 페이드아웃 중이 아닌 보이스 수
function liveVoices(ctx) {
  const outs = new Set();
  for (const o of ctx.oscillators) {
    if (o.disconnected || o.stopTime <= ctx.currentTime) continue;
    const out = voiceOutOf(o);
    if (!isFading(out)) outs.add(out);
  }
  return outs.size;
}

// 레벨 level 의 merge 를 재생하고 새로 생긴 첫 오실레이터의 도착 주파수를 돌려준다.
function mergeHz(audio, ctx, level) {
  ctx.advance(0.1);
  const before = ctx.oscillators.length;
  assert.equal(audio.play('merge', { level }), true);
  return ctx.oscillators[before].frequency.last.v;
}

test('AudioContext 가 없으면 어떤 호출도 던지지 않는다', (t) => {
  removeAudioContext(t);
  const audio = createAudio();
  assert.doesNotThrow(() => {
    audio.unlock();
    audio.unlock();
    for (const name of NAMES) assert.equal(audio.play(name, { level: 5 }), false);
    audio.play('없는-이름');
    audio.setMuted(true);
    audio.setMuted(false);
  });
  assert.equal(audio.isMuted(), false);
  audio.setMuted(true);
  assert.equal(audio.isMuted(), true);
});

test('AudioContext 생성자가 던져도 안전하고, 이후 제스처에서 다시 시도한다', async (t) => {
  const fake = installFake(t, { throwOnConstruct: true });
  const audio = createAudio();
  assert.doesNotThrow(() => audio.unlock());
  assert.equal(audio.play('click'), false);
  assert.equal(fake.contexts.length, 0);

  installFake(t); // 이번에는 정상 컨텍스트
  audio.unlock();
  await flush();
  assert.equal(audio.play('click'), true);
});

test('webkitAudioContext 폴백을 쓴다', async (t) => {
  const fake = installFake(t, { webkitOnly: true });
  const audio = createAudio();
  audio.unlock();
  await flush();
  assert.equal(fake.contexts.length, 1);
  assert.equal(audio.play('drop'), true);
});

test('unlock 전의 play 는 무음 no-op 이고 대기열에 쌓이지 않는다', async (t) => {
  const fake = installFake(t);
  const audio = createAudio();
  for (const name of NAMES) assert.equal(audio.play(name, { level: 3 }), false);
  assert.equal(fake.contexts.length, 0, 'play 가 컨텍스트를 만들면 안 된다');

  audio.unlock();
  await flush();
  assert.equal(fake.ctx.oscillators.length, 0, 'unlock 이전 호출이 되살아나면 안 된다');
});

test('unlock 은 멱등: 컨텍스트와 마스터 게인은 하나, 풀릴 때까지 resume 은 한 번', async (t) => {
  const fake = installFake(t);
  const audio = createAudio();
  audio.unlock();
  audio.unlock();
  audio.unlock();
  assert.equal(fake.contexts.length, 1);
  assert.equal(fake.ctx.gains.length, 1, '마스터 게인 하나뿐이어야 한다');
  assert.equal(fake.ctx.resumeCalls, 1);

  await flush();
  assert.equal(fake.ctx.state, 'running');
  audio.unlock();
  audio.unlock();
  assert.equal(fake.contexts.length, 1);
  assert.equal(fake.ctx.resumeCalls, 1, 'running 이면 resume 하지 않는다');
});

test('unlock 은 다시 suspended 가 된 컨텍스트를 resume 한다', async (t) => {
  const { audio, ctx } = await readyAudio(t);
  ctx.state = 'suspended'; // 탭 전환/전화 등으로 중단된 상황
  assert.equal(audio.play('click'), false, 'suspended 에서는 예약하지 않는다');
  assert.equal(ctx.oscillators.length, 0);

  audio.unlock();
  await flush();
  assert.equal(ctx.resumeCalls, 2);
  assert.equal(ctx.state, 'running');
  assert.equal(audio.play('click'), true);
});

test('resume 직후(첫 제스처)의 첫 소리는 살린다', (t) => {
  const fake = installFake(t); // suspended 로 시작, resume 은 비동기
  const audio = createAudio();
  audio.unlock();
  assert.equal(audio.play('click'), true);
  assert.ok(fake.ctx.oscillators.length > 0);
});

test('resume 이 거절되면 play 는 계속 무음 no-op', async (t) => {
  const fake = installFake(t, { resume: 'reject' });
  const audio = createAudio();
  audio.unlock();
  await flush();
  assert.equal(fake.ctx.state, 'suspended');
  for (const name of NAMES) assert.equal(audio.play(name), false);
  assert.equal(fake.ctx.oscillators.length, 0);
});

test('모든 소리가 재생되고 마스터 게인(<= 0.3) → 출력으로 연결된다', async (t) => {
  const { audio, ctx } = await readyAudio(t);
  for (const name of NAMES) {
    const before = ctx.oscillators.length;
    ctx.advance(0.1);
    assert.equal(audio.play(name, { level: 4 }), true, name);
    assert.ok(ctx.oscillators.length > before, `${name} 은 오실레이터를 만든다`);
  }
  const master = masterGain(ctx);
  assert.ok(master, '마스터 게인을 찾을 수 있어야 한다');
  assert.ok(master.gain.value > 0 && master.gain.value <= 0.3);
  assert.equal(audio.play('없는-이름'), false);
  assert.equal(audio.play(undefined), false);
});

test('음소거 상태에서는 오실레이터를 만들지 않는다 (unlock 전/후 모두)', async (t) => {
  const fake = installFake(t);
  const audio = createAudio();
  audio.setMuted(true);
  assert.equal(audio.isMuted(), true);
  audio.unlock();
  await flush();
  assert.equal(audio.isMuted(), true);

  for (const name of NAMES) {
    fake.ctx.advance(0.1);
    assert.equal(audio.play(name, { level: 7 }), false);
  }
  assert.equal(fake.ctx.oscillators.length, 0);
  assert.equal(masterGain(fake.ctx).gain.value, 0, '음소거로 시작하면 마스터 게인은 0');

  audio.setMuted(false);
  assert.equal(audio.isMuted(), false);
  assert.equal(audio.play('click'), true);
  assert.ok(fake.ctx.oscillators.length > 0);
});

test('음소거는 즉시 마스터 게인을 0 으로 만들고 재생 중인 소리를 정리한다', async (t) => {
  const { audio, ctx } = await readyAudio(t);
  const master = masterGain(ctx);
  assert.equal(audio.play('gameover'), true);
  assert.ok(master.gain.value > 0);

  audio.setMuted(true);
  assert.equal(master.gain.value, 0);
  assert.equal(audio.isMuted(), true);
  assert.ok(ctx.oscillators.length > 0);
  for (const o of ctx.oscillators) {
    assert.ok(o.disconnected, '재생 중이던 노드는 끊어진다');
    assert.ok(o.stopTime <= ctx.currentTime + 0.001, '음소거하면 오실레이터도 멈춘다');
  }

  const count = ctx.oscillators.length;
  ctx.advance(0.1);
  assert.equal(audio.play('drop'), false);
  assert.equal(ctx.oscillators.length, count);

  audio.setMuted(false);
  assert.ok(master.gain.value > 0 && master.gain.value <= 0.3);
});

test('같은 이름은 40ms 안에 한 번만, 다른 이름은 영향 없음', async (t) => {
  const { audio, ctx } = await readyAudio(t);
  assert.equal(audio.play('drop'), true);
  const afterFirst = ctx.oscillators.length;

  assert.equal(audio.play('drop'), false, '같은 시각 재호출');
  ctx.advance(0.039);
  assert.equal(audio.play('drop'), false, '39ms 뒤');
  assert.equal(ctx.oscillators.length, afterFirst);

  assert.equal(audio.play('click'), true, '다른 이름은 막지 않는다');

  ctx.advance(0.002);
  assert.equal(audio.play('drop'), true, '41ms 뒤');
  assert.ok(ctx.oscillators.length > afterFirst);
});

test('연쇄 합치기: 한 프레임에 몰린 merge 는 한 번만 울린다', async (t) => {
  const { audio, ctx } = await readyAudio(t);
  let played = 0;
  for (let level = 1; level <= 6; level += 1) if (audio.play('merge', { level })) played += 1;
  assert.equal(played, 1);
});

test('merge 음높이는 단계가 오를수록 높아진다 (10단계 > 1단계)', async (t) => {
  const { audio, ctx } = await readyAudio(t);
  const hz = [];
  for (let level = 1; level <= 10; level += 1) hz.push(mergeHz(audio, ctx, level));
  assert.ok(hz[9] > hz[0]);
  for (let i = 1; i < hz.length; i += 1) assert.ok(hz[i] > hz[i - 1], `level ${i + 1} > level ${i}`);
  assert.ok(hz.every((f) => f >= 80 && f <= 4000), '가청/쾌적 범위');
});

test('merge level 이 범위 밖이거나 이상한 값이어도 1..10 으로 보정된다', async (t) => {
  const { audio, ctx } = await readyAudio(t);
  const lv1 = mergeHz(audio, ctx, 1);
  const lv10 = mergeHz(audio, ctx, 10);
  assert.equal(mergeHz(audio, ctx, 0), lv1);
  assert.equal(mergeHz(audio, ctx, -5), lv1);
  assert.equal(mergeHz(audio, ctx, NaN), lv1);
  assert.equal(mergeHz(audio, ctx, undefined), lv1);
  assert.equal(mergeHz(audio, ctx, '7') > lv1, true);
  assert.equal(mergeHz(audio, ctx, 11), lv10);
  assert.equal(mergeHz(audio, ctx, 999), lv10);

  ctx.advance(0.1);
  assert.doesNotThrow(() => audio.play('merge')); // opts 없음
  ctx.advance(0.1);
  assert.doesNotThrow(() => audio.play('merge', null));
});

test('높은 단계의 merge 는 더 길고 더 풍성하다', async (t) => {
  const { audio, ctx } = await readyAudio(t);
  const measure = (level) => {
    ctx.advance(0.1);
    const from = ctx.oscillators.length;
    audio.play('merge', { level });
    const oscs = ctx.oscillators.slice(from);
    return { count: oscs.length, end: Math.max(...oscs.map((o) => o.stopTime)) - ctx.currentTime };
  };
  const low = measure(1);
  const high = measure(10);
  assert.ok(high.count > low.count);
  assert.ok(high.end > low.end);
});

test('모든 보이스의 엔벨로프는 0 으로 끝난 뒤에 오실레이터가 멈춘다 (클릭 노이즈 방지)', async (t) => {
  const { audio, ctx } = await readyAudio(t);
  for (const name of NAMES) {
    ctx.advance(0.1);
    audio.play(name, { level: 9 });
  }
  assert.ok(ctx.oscillators.length > 0);
  for (const osc of ctx.oscillators) {
    const env = osc.connections[0];
    const events = env.gain.events;
    assert.equal(events[0].v, 0, '0 에서 시작(어택)');
    assert.equal(events[events.length - 1].v, 0, '0 으로 끝남');
    assert.ok(events.every((e) => e.v >= 0 && e.v <= 1), '게인은 0..1');
    assert.ok(events.every((e, i) => i === 0 || e.t >= events[i - 1].t), '시간 순서');
    assert.ok(events[events.length - 1].t < osc.stopTime, '엔벨로프가 끝난 뒤에 stop');
    assert.ok(osc.startTime >= osc.createdAt, '과거 시각에 시작하지 않는다');
  }
});

test('보이스 상한: 가득 차면 일반 소리는 버리고, 우선 소리는 가장 오래된 것을 밀어낸다', async (t) => {
  const { audio, ctx } = await readyAudio(t);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(audio.play('gameover'), true, `gameover #${i + 1}`);
    ctx.advance(0.045);
  }
  assert.equal(liveVoices(ctx), 12);

  const count = ctx.oscillators.length;
  assert.equal(audio.play('merge', { level: 3 }), false, '가득 찼으면 일반 소리는 버린다');
  assert.equal(audio.play('drop'), false);
  assert.equal(ctx.oscillators.length, count, '버려진 소리는 노드를 만들지 않는다');

  const oldest = voiceOutOf(ctx.oscillators[0]);
  assert.equal(audio.play('clear'), true, '우선 소리는 재생된다');
  assert.ok(isFading(oldest), '가장 오래된 보이스가 페이드아웃된다');
  assert.equal(liveVoices(ctx), 12, '상한(12)을 넘지 않는다');

  ctx.advance(3);
  assert.equal(liveVoices(ctx), 0);
  assert.equal(audio.play('merge', { level: 3 }), true, '자리가 나면 다시 재생');
});

test('끝난 보이스의 노드는 disconnect 된다 (onended 경로)', async (t) => {
  const { audio, ctx } = await readyAudio(t);
  audio.play('merge', { level: 10 });
  const nodes = ctx.oscillators.flatMap((o) => [o, o.connections[0], voiceOutOf(o)]);
  assert.ok(nodes.length > 0);
  assert.ok(nodes.every((n) => !n.disconnected), '재생 중에는 연결 유지');

  ctx.advance(2);
  assert.ok(nodes.every((n) => n.disconnected), '끝나면 전부 끊긴다');
});

test('onended 가 오지 않아도 다음 play 때 끝난 보이스를 정리한다', async (t) => {
  const { audio, ctx } = await readyAudio(t, { fireEnded: false });
  audio.play('merge', { level: 10 });
  const firstOsc = ctx.oscillators[0];
  ctx.advance(2);
  assert.equal(firstOsc.disconnected, false);

  assert.equal(audio.play('click'), true);
  assert.equal(firstOsc.disconnected, true);
  assert.ok(ctx.oscillators.slice(0, -1).every((o) => o.disconnected));
});

test('노드 생성 중 예외가 나도 play 는 던지지 않고 부분 노드를 정리한다', async (t) => {
  const { audio, ctx } = await readyAudio(t);
  const real = ctx.createOscillator.bind(ctx);
  let calls = 0;
  ctx.createOscillator = () => {
    calls += 1;
    if (calls === 2) throw new Error('boom');
    return real();
  };

  assert.doesNotThrow(() => assert.equal(audio.play('drop'), false));
  assert.ok(ctx.oscillators.every((o) => o.disconnected));

  ctx.advance(0.1);
  assert.equal(audio.play('drop'), true, '실패한 시도는 쓰로틀을 소모하지 않는다');
});
