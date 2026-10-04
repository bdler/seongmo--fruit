// 게임 규칙(순수 로직). DOM/Matter/Canvas 를 모른다 — Node 에서도 import 해서 테스트한다.
// 모든 시간 인자는 '시뮬레이션 시간(ms)'이다. performance.now() 를 쓰지 않는다.
import {
  WORLD,
  LAST_LEVEL,
  DROP_WEIGHTS,
  TIMING,
  scoreOf,
  WATERMELON_PAIR_BONUS,
} from './config.js';

// 시뮬레이션 시간은 부동소수점이라 '정확히 N스텝 뒤' 비교가 어긋날 수 있다.
const EPS = 1e-6;

export const STATES = Object.freeze({
  IDLE: 'IDLE',
  READY: 'READY',
  COOLDOWN: 'COOLDOWN',
  GAME_OVER: 'GAME_OVER',
});

// 가중치대로 떨어뜨릴 과일 단계를 뽑는다. rng 는 [0,1) 을 돌려주는 함수.
export function pickDropLevel(rng = Math.random, weights = DROP_WEIGHTS) {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng() * total;
  for (let level = 0; level < weights.length; level++) {
    r -= weights[level];
    if (r < 0) return level;
  }
  return weights.length - 1; // rng() 가 1 이거나 부동소수점 오차일 때
}

// 경계선 위 체류를 판정한다.
// items: { y, radius, bornAt, overSince } 목록(overSince 는 이 함수가 갱신한다).
// 반환: { danger: 0..1, over: boolean }
export function evaluateOverflow(items, simTime, cfg = {}) {
  const dangerY = cfg.dangerY ?? WORLD.dangerY;
  const settleGrace = cfg.settleGrace ?? TIMING.settleGrace;
  const overflow = cfg.overflow ?? TIMING.overflow;

  let danger = 0;
  for (const it of items) {
    // 방금 드롭/생성된 과일은 판정 제외 + 타이머 리셋
    if (simTime - it.bornAt < settleGrace) {
      it.overSince = null;
      continue;
    }
    if (it.y - it.radius < dangerY) {
      if (it.overSince == null) it.overSince = simTime;
      const ratio = (simTime - it.overSince) / overflow;
      if (ratio > danger) danger = ratio;
    } else {
      it.overSince = null;
    }
  }
  danger = Math.min(1, Math.max(0, danger));
  return { danger, over: danger >= 1 - EPS };
}

export function createGame({ rng = Math.random } = {}) {
  let state = STATES.IDLE;
  let score = 0;
  let maxLevel = 0;
  let drops = 0;
  let cleared = false;
  let current = null;
  let next = null;
  let danger = 0;
  let cooldownUntil = 0;
  let startedAt = null;
  let endedAt = null;

  const isPlaying = () => state === STATES.READY || state === STATES.COOLDOWN;

  function reset() {
    state = STATES.IDLE;
    score = 0;
    maxLevel = 0;
    drops = 0;
    cleared = false;
    current = null;
    next = null;
    danger = 0;
    cooldownUntil = 0;
    startedAt = null;
    endedAt = null;
  }

  // 새 판 시작(재시작 포함). 이전 판의 상태는 모두 지운다.
  function start(simTime) {
    reset();
    current = pickDropLevel(rng);
    next = pickDropLevel(rng);
    startedAt = simTime;
    state = STATES.READY;
  }

  // READY 일 때만 드롭된다. 떨어뜨린 과일 단계를 돌려주고, 아니면 null.
  function drop(simTime) {
    if (state !== STATES.READY) return null;
    const level = current;
    drops += 1;
    if (level > maxLevel) maxLevel = level;
    current = next;
    next = pickDropLevel(rng);
    cooldownUntil = simTime + TIMING.dropCooldown;
    state = STATES.COOLDOWN;
    return level;
  }

  // 시간에 따른 상태 전이(쿨다운 종료). 매 물리 스텝마다 호출한다.
  function update(simTime) {
    if (state === STATES.COOLDOWN && simTime + EPS >= cooldownUntil) state = STATES.READY;
    return state;
  }

  // physics 의 onMerge 이벤트를 점수에 반영하고 얻은 점수를 돌려준다.
  // 수박 쌍(bonus)은 새 과일이 생기지 않으므로 보너스 점수만 준다.
  function applyMerge(evt) {
    if (!isPlaying()) return 0;
    const points = evt.bonus ? WATERMELON_PAIR_BONUS : scoreOf(evt.level);
    score += points;
    if (evt.level > maxLevel) maxLevel = evt.level;
    if (evt.level === LAST_LEVEL) cleared = true;
    return points;
  }

  // 경계선 체류 판정. 게임오버가 되면 true.
  function checkOverflow(items, simTime) {
    if (!isPlaying()) return false;
    const res = evaluateOverflow(items, simTime);
    danger = res.danger;
    if (res.over) endGame(simTime);
    return res.over;
  }

  function endGame(simTime) {
    if (!isPlaying()) return;
    state = STATES.GAME_OVER;
    endedAt = simTime;
  }

  // 판이 진행된 시뮬레이션 시간. 끝난 판은 종료 시점에서 멈춘다.
  function playTimeMs(simTime) {
    if (startedAt == null) return 0;
    const end = endedAt ?? simTime ?? startedAt;
    return Math.max(0, end - startedAt);
  }

  return {
    reset,
    start,
    drop,
    update,
    applyMerge,
    checkOverflow,
    endGame,
    playTimeMs,
    get state() { return state; },
    get score() { return score; },
    get maxLevel() { return maxLevel; },
    get drops() { return drops; },
    get cleared() { return cleared; },
    get current() { return current; },
    get next() { return next; },
    get danger() { return danger; },
    get cooldownUntil() { return cooldownUntil; },
    get isPlaying() { return isPlaying(); },
  };
}
