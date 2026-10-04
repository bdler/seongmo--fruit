// 효과음: Web Audio 합성만 사용한다 (오디오 파일 없음).
// AudioContext 가 없거나 브라우저가 막아도 어떤 호출도 던지지 않고 조용히 무시한다.

const MASTER_GAIN = 0.25;  // 마스터 볼륨 (계약: <= 0.3)
const THROTTLE_S = 0.04;   // 같은 이름의 소리는 이 간격에 한 번만 (연쇄 합치기 폭주 방지)
const MAX_VOICES = 12;     // 동시에 울리는 소리 수 상한 (play 한 번 = 보이스 하나)
const START_DELAY_S = 0.005;
const FLOOR = 0.0001;      // exponentialRamp 는 0 으로 갈 수 없어 여기까지 내린 뒤 선형으로 0 마무리
const TAIL_S = 0.03;       // 엔벨로프가 0 이 된 뒤 osc.stop 까지의 여유
const FADE_S = 0.02;       // 보이스를 빼앗을 때 페이드아웃 시간
const RESUME_GRACE_MS = 250;

const LEVEL_MIN = 1;
const LEVEL_MAX = 10;
// 합치기 음높이: A 장조 펜타토닉(라 시 도# 미 파#) 2옥타브 → 어떤 조합이 겹쳐도 어울린다.
const PENTATONIC = [0, 2, 4, 7, 9];
const BASE_HZ = 220;

function clampLevel(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return LEVEL_MIN;
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, n));
}

function hzOf(level) {
  const i = level - LEVEL_MIN;
  const semitones = 12 * Math.floor(i / PENTATONIC.length) + PENTATONIC[i % PENTATONIC.length];
  return BASE_HZ * 2 ** (semitones / 12);
}

// 소리 레시피. add(note) 로 음을 쌓는다.
// note = { type, f, to?, glide?, t, dur, peak, attack? }  (f→to 로 glide 초 동안 지수 슬라이드)
// priority 소리는 보이스가 가득 차도 가장 오래된 소리를 밀어내고 재생된다.
const SOUNDS = {
  // 부드럽고 짧은 툭
  drop: {
    build(add, t) {
      add({ type: 'sine', f: 190, to: 70, glide: 0.12, t, dur: 0.16, peak: 0.6, attack: 0.004 });
      add({ type: 'triangle', f: 520, to: 240, glide: 0.04, t, dur: 0.07, peak: 0.12, attack: 0.002 });
    },
  },

  // 뽀글 터지는 소리: 아래에서 위로 튀는 음. 단계가 높을수록 길고 배음이 늘어난다.
  merge: {
    build(add, t, opts) {
      const level = clampLevel(opts && opts.level);
      const f = hzOf(level);
      const d = 0.14 + 0.02 * (level - LEVEL_MIN);
      add({ type: 'sine', f: f * 0.7, to: f, glide: 0.05, t, dur: d, peak: 0.5 });
      add({ type: 'triangle', f: f * 1.4, to: f * 2, glide: 0.05, t, dur: d * 0.6, peak: 0.14 });
      if (level >= 5) add({ type: 'sine', f: f * 1.5, t: t + 0.03, dur: d * 0.85, peak: 0.12 });
      if (level >= 8) add({ type: 'sine', f: f * 3, t: t + 0.07, dur: d * 0.8, peak: 0.06 });
    },
  },

  // 첫 수박: 상승 아르페지오 + 마지막 화음
  clear: {
    priority: true,
    build(add, t) {
      const step = 0.085;
      const arp = [440, 554.37, 659.25, 880];
      arp.forEach((f, i) => add({ type: 'triangle', f, t: t + i * step, dur: 0.16, peak: 0.35 }));
      const chordAt = t + arp.length * step;
      [659.25, 880, 1108.73].forEach((f) =>
        add({ type: 'triangle', f, t: chordAt, dur: 0.55, peak: 0.25, attack: 0.012 }),
      );
    },
  },

  // 게임오버: 내려가는 짧은 악구 + 아래로 처지는 긴 음
  gameover: {
    priority: true,
    build(add, t) {
      const step = 0.2;
      const phrase = [659.25, 587.33, 523.25];
      phrase.forEach((f, i) =>
        add({ type: 'triangle', f, to: f * 0.97, glide: 0.2, t: t + i * step, dur: 0.22, peak: 0.4 }),
      );
      const tailAt = t + phrase.length * step;
      add({ type: 'triangle', f: 440, to: 330, glide: 0.7, t: tailAt, dur: 0.8, peak: 0.4 });
      add({ type: 'sine', f: 220, to: 165, glide: 0.7, t: tailAt, dur: 0.8, peak: 0.25 });
    },
  },

  // UI 틱
  click: {
    build(add, t) {
      add({ type: 'triangle', f: 1400, to: 900, glide: 0.03, t, dur: 0.045, peak: 0.22, attack: 0.002 });
    },
  },
};

const hasSound = (name) => Object.prototype.hasOwnProperty.call(SOUNDS, name);

export function createAudio() {
  let ctx = null;
  let master = null;
  let muted = false;
  let graceUntil = 0; // resume 진행 중으로 보고 재생을 허용하는 시한(Date.now 기준)
  const voices = [];
  const lastAt = Object.create(null);
  for (const name of Object.keys(SOUNDS)) lastAt[name] = -Infinity;

  const safe = (fn) => {
    try {
      fn();
    } catch {
      // 오디오 실패는 게임에 영향을 주지 않는다
    }
  };

  function ensureContext() {
    if (ctx) return true;
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (typeof Ctor !== 'function') return false;
    let c = null;
    try {
      c = new Ctor();
      const m = c.createGain();
      m.gain.value = muted ? 0 : MASTER_GAIN;
      let tail = m;
      if (typeof c.createDynamicsCompressor === 'function') {
        // 소리가 겹칠 때 찢어지지 않도록 마지막에 가볍게 눌러 준다
        const comp = c.createDynamicsCompressor();
        safe(() => {
          comp.threshold.value = -14;
          comp.knee.value = 12;
          comp.ratio.value = 8;
          comp.attack.value = 0.003;
          comp.release.value = 0.15;
        });
        m.connect(comp);
        tail = comp;
      }
      tail.connect(c.destination);
      ctx = c;
      master = m;
      return true;
    } catch {
      if (c && typeof c.close === 'function') safe(() => c.close());
      return false;
    }
  }

  function unlock() {
    try {
      if (!ensureContext()) return;
      if (ctx.state === 'running' || Date.now() < graceUntil) return;
      graceUntil = Date.now() + RESUME_GRACE_MS;
      const settled = () => {
        graceUntil = 0;
      };
      const p = ctx.resume();
      if (p && typeof p.then === 'function') p.then(settled, settled);
    } catch {
      // 무시
    }
  }

  function release(voice) {
    if (voice.released) return;
    voice.released = true;
    const i = voices.indexOf(voice);
    if (i >= 0) voices.splice(i, 1);
    for (const node of voice.nodes) safe(() => node.disconnect());
  }

  function addNote(voice, n) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const t = n.t;
    const attack = Math.min(n.attack || 0.008, n.dur / 2);
    osc.type = n.type;
    osc.frequency.setValueAtTime(n.f, t);
    if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, t + (n.glide || n.dur));
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(n.peak, t + attack);
    env.gain.exponentialRampToValueAtTime(FLOOR, t + n.dur);
    env.gain.linearRampToValueAtTime(0, t + n.dur + 0.01);
    osc.connect(env);
    env.connect(voice.out);
    voice.nodes.push(osc, env);
    voice.oscs.push(osc);
    voice.pending += 1;
    osc.onended = () => {
      voice.pending -= 1;
      if (voice.pending <= 0) release(voice);
    };
    osc.start(t);
    osc.stop(t + n.dur + TAIL_S);
    voice.end = Math.max(voice.end, t + n.dur + TAIL_S);
  }

  // 가장 오래된 소리를 짧게 페이드아웃시키고 상한 계산에서 제외한다
  function fadeOut(voice, now) {
    voice.fading = true;
    safe(() => {
      voice.out.gain.setValueAtTime(1, now);
      voice.out.gain.linearRampToValueAtTime(0, now + FADE_S);
    });
    const stopAt = now + FADE_S + 0.01;
    for (const osc of voice.oscs) safe(() => osc.stop(stopAt));
    voice.end = Math.min(voice.end, stopAt + TAIL_S);
  }

  function startVoice(recipe, opts, now) {
    const voice = {
      out: ctx.createGain(),
      nodes: [],
      oscs: [],
      pending: 0,
      end: now,
      fading: false,
      released: false,
    };
    voice.nodes.push(voice.out);
    voices.push(voice);
    try {
      voice.out.connect(master);
      recipe.build((note) => addNote(voice, note), now + START_DELAY_S, opts);
      return true;
    } catch {
      for (const osc of voice.oscs) safe(() => osc.stop());
      release(voice);
      return false;
    }
  }

  function play(name, opts) {
    try {
      if (muted || !ctx || !hasSound(name)) return false;
      // suspended(자동재생 차단) 컨텍스트에 예약하면 풀릴 때 한꺼번에 터지므로 버린다.
      // 단, 방금 resume 을 요청한 짧은 구간은 첫 소리를 살리려고 허용한다.
      if (ctx.state !== 'running' && Date.now() >= graceUntil) return false;

      const now = Number(ctx.currentTime) || 0;
      if (now - lastAt[name] < THROTTLE_S) return false;

      for (const v of voices.slice()) if (now >= v.end) release(v);
      const live = voices.filter((v) => !v.fading);
      const recipe = SOUNDS[name];
      if (live.length >= MAX_VOICES) {
        if (!recipe.priority) return false;
        fadeOut(live[0], now);
      }

      if (!startVoice(recipe, opts, now)) return false;
      lastAt[name] = now;
      return true;
    } catch {
      return false;
    }
  }

  function setMuted(value) {
    muted = !!value;
    safe(() => {
      if (master) master.gain.value = muted ? 0 : MASTER_GAIN;
    });
    if (muted) {
      // 마스터가 이미 0 이지만, 해제했을 때 남은 꼬리가 되살아나지 않도록 정리한다
      for (const v of voices.slice()) {
        for (const osc of v.oscs) safe(() => osc.stop());
        release(v);
      }
    }
  }

  return { unlock, play, setMuted, isMuted: () => muted };
}
