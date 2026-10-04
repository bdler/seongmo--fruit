// Matter.js 래퍼: 상자, 과일 바디, 충돌 → 합치기 큐.
// 전역 Matter(CDN 스크립트)를 쓰므로 import 하지 않는다. createPhysics() 호출 시점에 읽는다.
import { WORLD, FRUITS, LAST_LEVEL, PHYSICS } from './config.js';

// 벽은 플레이 영역 '바깥'에 둔다. 얇으면 빠른 과일이 터널링으로 뚫으므로 두껍게,
// 튕겨 오른 과일이 넘어가지 못하도록 위쪽으로 아주 높게 세운다(천장은 없음).
const WALL_THICKNESS = Math.max(WORLD.wall, 100);
const WALL_TOP = -2000;
// 정상 낙하의 최고 속도(약 18px/step)보다 훨씬 큰 안전 상한.
const MAX_SPEED = 40;
// Matter의 원은 다각형 근사다. 면 수를 늘리면 큰 과일이 더 매끄럽게 구른다.
const CIRCLE_SIDES = 32;
// 큰 과일이 합쳐져 태어나면 이웃한 작은 과일이 벽 쪽으로 깊이 눌린다(반복 횟수를 올려도 없어지지 않음).
// 중심이 벽 면에서 반지름의 이 비율만큼은 안쪽에 있도록 매 스텝 되돌려, 벽을 파고들어 사라지는 일을 막는다.
const MIN_CENTER_DEPTH = 0.5;

export function createPhysics({ onMerge }) {
  const { Engine, Bodies, Body, Composite, Events } = Matter;
  const { width: W, height: H } = WORLD;

  // 반복 횟수를 기본값(6/4)보다 올려 큰 과일이 작은 과일 위에 쌓일 때의 떨림을 줄인다.
  const engine = Engine.create({
    gravity: { x: 0, y: PHYSICS.gravityY },
    positionIterations: 10,
    velocityIterations: 8,
  });
  const world = engine.world;

  const live = new Set(); // 살아 있는 과일 바디
  const queue = []; // [bodyA, bodyB] 합치기 대기열

  addWalls();
  Events.on(engine, 'collisionStart', onCollide);
  // 겹친 채로 태어난 과일은 collisionStart 가 다시 오지 않으므로 Active 도 본다.
  Events.on(engine, 'collisionActive', onCollide);

  function addWalls() {
    const t = WALL_THICKNESS;
    const bottom = H + t;
    const wallH = bottom - WALL_TOP;
    const wallY = (WALL_TOP + bottom) / 2;
    const opts = { isStatic: true, friction: PHYSICS.friction, restitution: 0, label: 'wall' };
    Composite.add(world, [
      Bodies.rectangle(W / 2, H + t / 2, W + t * 2, t, opts), // 바닥
      Bodies.rectangle(-t / 2, wallY, t, wallH, opts), // 왼쪽 벽
      Bodies.rectangle(W + t / 2, wallY, t, wallH, opts), // 오른쪽 벽
    ]);
  }

  // 충돌 콜백에서는 월드를 건드리지 않고 '표시'만 한다.
  function onCollide(event) {
    for (const { bodyA: a, bodyB: b } of event.pairs) {
      if (!a.isFruit || !b.isFruit) continue;
      if (a.level !== b.level || a.merging || b.merging) continue;
      a.merging = true;
      b.merging = true;
      queue.push([a, b]);
    }
  }

  function spawn(level, x, y, simTime, opts = {}) {
    const def = FRUITS[level];
    if (!def) throw new RangeError(`알 수 없는 과일 단계: ${level}`);
    const body = Bodies.circle(x, y, def.radius, {
      label: 'fruit',
      restitution: PHYSICS.restitution,
      friction: PHYSICS.friction,
      frictionStatic: PHYSICS.frictionStatic,
    }, CIRCLE_SIDES);
    body.isFruit = true;
    body.level = level;
    body.merging = false;
    body.bornAt = simTime;
    body.mergedAt = opts.merged ? simTime : -Infinity;
    body.overSince = null;
    if (opts.velocity) Body.setVelocity(body, opts.velocity);
    Composite.add(world, body);
    live.add(body);
    return body;
  }

  function removeBody(body) {
    live.delete(body);
    Composite.remove(world, body);
  }

  function clampSpeeds() {
    for (const body of live) {
      const { x, y } = body.velocity;
      const speed = Math.hypot(x, y);
      if (speed > MAX_SPEED) {
        const k = MAX_SPEED / speed;
        Body.setVelocity(body, { x: x * k, y: y * k });
      }
    }
  }

  // 안전망: 벽/바닥에 너무 깊이 파고든 과일을 끌어내고, 파고드는 방향의 속도는 없앤다.
  function confineToBox() {
    for (const body of live) {
      const r = FRUITS[body.level].radius * MIN_CENTER_DEPTH;
      const { x, y } = body.position;
      const nx = Math.min(Math.max(x, r), W - r);
      const ny = Math.min(y, H - r);
      if (nx === x && ny === y) continue;
      Body.setPosition(body, { x: nx, y: ny });
      const { x: vx, y: vy } = body.velocity;
      Body.setVelocity(body, {
        x: nx > x ? Math.max(vx, 0) : nx < x ? Math.min(vx, 0) : vx,
        y: ny < y ? Math.min(vy, 0) : vy,
      });
    }
  }

  function flushMerges(simTime) {
    const pending = queue.splice(0);
    let firstError = null;
    for (const [a, b] of pending) {
      if (!live.has(a) || !live.has(b)) continue; // clear() 등으로 이미 사라짐
      const x = (a.position.x + b.position.x) / 2;
      const y = (a.position.y + b.position.y) / 2;
      const level = a.level;
      const velocity = {
        x: (a.velocity.x + b.velocity.x) / 2,
        y: (a.velocity.y + b.velocity.y) / 2,
      };
      removeBody(a);
      removeBody(b);
      let evt;
      if (level === LAST_LEVEL) {
        evt = { level, x, y, bonus: true };
      } else {
        spawn(level + 1, x, y, simTime, { merged: true, velocity });
        evt = { level: level + 1, x, y, bonus: false };
      }
      // 콜백이 던져도 나머지 합치기가 중간 상태(merging=true 로 고착)로 남지 않게 한다.
      try {
        onMerge(evt);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError) throw firstError;
  }

  function step(dtMs, simTime) {
    Engine.update(engine, dtMs);
    clampSpeeds();
    confineToBox();
    flushMerges(simTime);
  }

  function clear() {
    queue.length = 0;
    if (live.size) Composite.remove(world, [...live]);
    live.clear();
  }

  return { step, spawn, bodies: () => [...live], clear };
}
