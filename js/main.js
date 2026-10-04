// 앱 진입점: 모듈을 엮고 게임 루프를 돌린다.
// 규칙은 game.js, 물리는 physics.js, 그리기는 render.js — 여기는 연결(wiring)만 한다.
import { WORLD, FRUITS, TIMING, NICKNAME_MAX, RANKING_LIMIT } from './config.js';
import { createGame } from './game.js';
import { createPhysics } from './physics.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';
import { createInput } from './input.js';
import * as storage from './storage.js';
import { isApiConfigured, fetchRanking, submitScore } from './api.js';

const MAX_FRAME_MS = 100; // 탭 전환 후 복귀 시 물리 폭주 방지
const BANNER_MS = 2500;
const RANK_MEDALS = ['🥇', '🥈', '🥉'];

const MSG = {
  noEngine: '물리 엔진(Matter.js)을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.',
  initFailed: '게임을 시작하지 못했어요. 페이지를 새로고침해 주세요.',
  offline: '랭킹 서버가 연결되지 않았어요. 오프라인 모드로 최고 점수만 저장돼요.',
  loadingRanking: '랭킹 불러오는 중…',
  rankingFailed: '랭킹을 불러오지 못했어요. 잠시 후 다시 열어 주세요.',
  rankingEmpty: '아직 등록된 기록이 없어요. 첫 기록을 남겨 보세요!',
  nicknameRule: `닉네임은 1~${NICKNAME_MAX}자로 입력해 주세요.`,
  submitting: '등록 중…',
  submitted: '랭킹에 등록했어요! 🎉',
  submitFailed: '등록하지 못했어요.',
};

const SUBMIT_LABEL = { idle: '랭킹 등록', retry: '다시 시도', done: '등록 완료' };

const SUBMIT_ERRORS = {
  timeout: '서버 응답이 늦어요. 다시 시도해 주세요.',
  network: '네트워크 연결을 확인하고 다시 시도해 주세요.',
  bad_response: '서버 응답을 이해하지 못했어요. 다시 시도해 주세요.',
  server_busy: '서버가 바빠요. 잠시 후 다시 시도해 주세요.',
  throttled: '너무 자주 등록하고 있어요. 잠시 후 다시 시도해 주세요.',
  invalid_nickname: '사용할 수 없는 닉네임이에요. 다른 닉네임을 입력해 주세요.',
  invalid_score: '이 기록은 등록할 수 없어요.',
  implausible: '이 기록은 등록할 수 없어요.',
  bad_request: '이 기록은 등록할 수 없어요.',
  not_configured: '랭킹 서버가 연결되지 않았어요.',
};

// 다시 시도하면 성공할 수 있는 오류. 나머지는 재시도해도 같은 결과다.
const RETRYABLE = new Set(['timeout', 'network', 'bad_response', 'server_busy', 'throttled']);

const $ = (id) => document.getElementById(id);

function queryDom() {
  return {
    score: $('score'),
    best: $('best'),
    nextCanvas: $('next-canvas'),
    btnMute: $('btn-mute'),
    stage: $('stage'),
    gameCanvas: $('game-canvas'),
    clearBanner: $('clear-banner'),
    screenStart: $('screen-start'),
    startError: $('start-error'),
    btnStart: $('btn-start'),
    btnViewRanking: $('btn-view-ranking'),
    screenGameover: $('screen-gameover'),
    finalScore: $('final-score'),
    newRecord: $('new-record'),
    finalBest: $('final-best'),
    finalFruit: $('final-fruit'),
    submitForm: $('submit-form'),
    inputNickname: $('input-nickname'),
    btnSubmit: $('btn-submit'),
    submitStatus: $('submit-status'),
    rankingStatus: $('ranking-status'),
    rankingList: $('ranking-list'),
    btnRestart: $('btn-restart'),
    screenRanking: $('screen-ranking'),
    rankingViewStatus: $('ranking-view-status'),
    rankingViewList: $('ranking-view-list'),
    btnCloseRanking: $('btn-close-ranking'),
    evolutionList: $('evolution-list'),
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const focusSoft = (el) => el?.focus?.({ preventScroll: true });
const prefersFinePointer = () => !!globalThis.matchMedia?.('(pointer: fine)').matches;

function showStartError(dom, text) {
  dom.startError.textContent = text;
  dom.startError.hidden = false;
}

// ───────────────────────── 진화 순서 / HUD ─────────────────────────

function buildEvolutionList(listEl) {
  listEl.replaceChildren();
  for (const fruit of FRUITS) {
    const li = document.createElement('li');
    li.dataset.level = String(fruit.level);
    li.textContent = fruit.emoji;
    li.title = fruit.name;
    li.setAttribute('aria-label', fruit.name);
    listEl.append(li);
  }
}

function createHud(dom) {
  let bannerTimer = 0;

  function hideBanner() {
    clearTimeout(bannerTimer);
    dom.clearBanner.hidden = true;
  }

  return {
    setScore: (n) => void (dom.score.textContent = String(n)),
    setBest: (n) => void (dom.best.textContent = String(n)),
    showBanner() {
      clearTimeout(bannerTimer);
      dom.clearBanner.hidden = false;
      bannerTimer = setTimeout(hideBanner, BANNER_MS);
    },
    hideBanner,
    setMuted(muted) {
      dom.btnMute.setAttribute('aria-pressed', String(muted));
      dom.btnMute.setAttribute('aria-label', muted ? '소리 켜기' : '소리 끄기');
      dom.btnMute.textContent = muted ? '🔇' : '🔊';
    },
  };
}

// ───────────────────────── 랭킹 표시 ─────────────────────────

function formatScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('ko-KR') : '-';
}

// 서버 데이터는 반드시 textContent 로만 넣는다.
function renderRankingRows(listEl, rows) {
  listEl.replaceChildren();
  rows.forEach((row, i) => {
    const li = document.createElement('li');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = RANK_MEDALS[i] ?? String(i + 1);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = String(row?.nickname ?? '');
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = formatScore(row?.score);
    li.append(rank, name, pts);
    listEl.append(li);
  });
}

// 같은 목록에 요청이 겹치면(재시작/닫기/재조회) 늦게 도착한 이전 응답은 버린다.
function createRankingLoader() {
  const tokens = new WeakMap();
  const bump = (listEl) => {
    const token = (tokens.get(listEl) ?? 0) + 1;
    tokens.set(listEl, token);
    return token;
  };

  async function load(listEl, statusEl) {
    const token = bump(listEl);
    listEl.replaceChildren();
    if (!isApiConfigured()) {
      statusEl.textContent = MSG.offline;
      return;
    }
    statusEl.textContent = MSG.loadingRanking;
    let res;
    try {
      res = await fetchRanking(RANKING_LIMIT);
    } catch {
      res = { ok: false, error: 'network' };
    }
    if (tokens.get(listEl) !== token) return;
    if (!res?.ok || !Array.isArray(res.data)) {
      statusEl.textContent = MSG.rankingFailed;
      return;
    }
    statusEl.textContent = res.data.length ? '' : MSG.rankingEmpty;
    renderRankingRows(listEl, res.data);
  }

  return { load, invalidate: bump };
}

function setupRankingOverlay(app) {
  const { dom, ranking } = app;

  function open() {
    dom.screenStart.hidden = true;
    dom.screenRanking.hidden = false;
    ranking.load(dom.rankingViewList, dom.rankingViewStatus);
    focusSoft(dom.btnCloseRanking);
  }

  function close() {
    if (dom.screenRanking.hidden) return;
    ranking.invalidate(dom.rankingViewList);
    dom.screenRanking.hidden = true;
    if (app.game.state === 'IDLE') {
      dom.screenStart.hidden = false;
      focusSoft(dom.btnViewRanking);
    }
  }

  dom.btnViewRanking.addEventListener('click', open);
  dom.btnCloseRanking.addEventListener('click', close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

// ───────────────────────── 결과 화면 / 점수 제출 ─────────────────────────

function createResultPanel({ dom, ranking }) {
  let result = null; // 이번 판의 결과 (제출은 라이브 상태가 아니라 이 스냅샷으로 한다)
  let busy = false;
  let done = false;

  const setStatus = (text) => void (dom.submitStatus.textContent = text);

  function reset() {
    result = null;
    busy = false;
    done = false;
    ranking.invalidate(dom.rankingList);
    dom.rankingList.replaceChildren();
    dom.rankingStatus.textContent = '';
    dom.inputNickname.disabled = false;
    dom.btnSubmit.disabled = false;
    dom.btnSubmit.textContent = SUBMIT_LABEL.idle;
    setStatus('');
  }

  function focusAfterShow() {
    const panel = dom.screenGameover.querySelector('.panel');
    if (panel) panel.tabIndex = -1;
    // 데스크톱은 곧바로 닉네임을 칠 수 있게, 터치 기기는 키보드가 튀어나오지 않게 패널에 둔다.
    const canType = prefersFinePointer() && !dom.submitForm.hidden;
    focusSoft(canType ? dom.inputNickname : panel ?? dom.btnRestart);
  }

  function show(res, { best, isRecord }) {
    reset();
    result = res;
    dom.finalScore.textContent = String(res.score);
    dom.finalBest.textContent = String(best);
    const fruit = FRUITS[res.maxLevel] ?? FRUITS[0];
    dom.finalFruit.textContent = `${fruit.emoji} ${fruit.name}`;
    dom.newRecord.hidden = !isRecord;
    dom.inputNickname.value = storage.getNickname();
    dom.submitForm.hidden = !isApiConfigured();
    dom.screenGameover.hidden = false;
    ranking.load(dom.rankingList, dom.rankingStatus);
    focusAfterShow();
  }

  function hide() {
    dom.screenGameover.hidden = true;
    reset();
  }

  function onSubmitResult(res, payload, mine) {
    const code = res?.error;
    if (res?.ok) {
      storage.clearPending();
    } else if (RETRYABLE.has(code)) {
      storage.setPending(payload);
    }
    if (result !== mine) return; // 그 사이 다음 판이 시작됨: 화면은 건드리지 않는다

    if (res?.ok) {
      done = true;
      setStatus(MSG.submitted);
      dom.btnSubmit.textContent = SUBMIT_LABEL.done;
      dom.inputNickname.disabled = true;
      ranking.load(dom.rankingList, dom.rankingStatus);
      return;
    }
    setStatus(SUBMIT_ERRORS[code] ?? MSG.submitFailed);
    if (RETRYABLE.has(code)) dom.btnSubmit.textContent = SUBMIT_LABEL.retry;
    // 재시도로 풀리는 오류와, 닉네임만 고치면 되는 오류에서만 버튼을 다시 연다.
    if (RETRYABLE.has(code) || code === 'invalid_nickname') {
      dom.btnSubmit.disabled = false;
      focusSoft(code === 'invalid_nickname' ? dom.inputNickname : dom.btnSubmit);
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (!result || busy || done) return;
    const nickname = dom.inputNickname.value.trim();
    if (nickname.length < 1 || nickname.length > NICKNAME_MAX) {
      setStatus(MSG.nicknameRule);
      focusSoft(dom.inputNickname);
      return;
    }
    storage.setNickname(nickname);
    const mine = result;
    const payload = {
      nickname,
      score: mine.score,
      maxLevel: mine.maxLevel,
      playTimeMs: mine.playTimeMs,
      drops: mine.drops,
      clientId: storage.getClientId(),
    };
    busy = true;
    dom.btnSubmit.disabled = true;
    setStatus(MSG.submitting);
    let res;
    try {
      res = await submitScore(payload);
    } catch {
      res = { ok: false, error: 'network' };
    }
    busy = false;
    onSubmitResult(res, payload, mine);
  }

  dom.submitForm.addEventListener('submit', onSubmit);
  return { show, hide };
}

// 이전에 실패해 저장해 둔 점수를 부팅 때 조용히 한 번만 다시 보낸다.
async function resubmitPending() {
  if (!isApiConfigured()) return;
  const pending = storage.getPending();
  if (!pending) return;
  let res;
  try {
    res = await submitScore({ ...pending, clientId: pending.clientId ?? storage.getClientId() });
  } catch {
    return;
  }
  if (res?.ok || (res && !RETRYABLE.has(res.error))) storage.clearPending();
}

// ───────────────────────── 시뮬레이션 ─────────────────────────

const isOverlayOpen = (dom) => [dom.screenStart, dom.screenGameover, dom.screenRanking].some((el) => !el.hidden);

// 대기 중인 과일의 x: 조준 위치를 그 과일 반지름만큼 안쪽으로 제한
function heldX(app) {
  const r = FRUITS[app.game.current ?? 0].radius;
  return clamp(app.aimX, r, WORLD.width - r);
}

function startGame(app) {
  const { dom, game } = app;
  app.audio.unlock();
  dom.screenStart.hidden = true;
  dom.screenRanking.hidden = true;
  app.panel.hide();
  app.physics.clear();
  game.start(app.simTime);
  app.aimX = WORLD.width / 2;
  app.acc = 0;
  app.last = null;
  app.best = storage.getBest();
  app.hud.setScore(0);
  app.hud.setBest(app.best);
  app.hud.hideBanner();
  app.renderer.drawNext(game.next);
  document.activeElement?.blur?.(); // 숨겨진 버튼에 포커스가 남아 스페이스가 먹히는 일 방지
}

function dropFruit(app) {
  const { game } = app;
  if (isOverlayOpen(app.dom)) return;
  const x = heldX(app);
  const level = game.drop(app.simTime);
  if (level === null) return; // READY 가 아님(쿨다운/게임오버)
  app.physics.spawn(level, x, WORLD.spawnY, app.simTime);
  app.audio.play('drop');
  app.renderer.addDropEffect({ x, y: WORLD.spawnY, level });
  app.renderer.drawNext(game.next);
}

function handleMerge(app, evt) {
  const { game, hud } = app;
  const wasCleared = game.cleared;
  const points = game.applyMerge(evt);
  hud.setScore(game.score);
  if (game.score > app.best) {
    app.best = game.score;
    hud.setBest(app.best);
  }
  app.audio.play('merge', { level: evt.level });
  app.renderer.addMergeEffect({ x: evt.x, y: evt.y, level: evt.level, bonus: evt.bonus, points });
  if (!wasCleared && game.cleared) {
    hud.showBanner();
    app.audio.play('clear');
  }
}

function handleGameOver(app) {
  const { game } = app;
  app.hud.hideBanner();
  app.audio.play('gameover');
  const result = {
    score: game.score,
    maxLevel: game.maxLevel,
    drops: game.drops,
    playTimeMs: Math.round(game.playTimeMs(app.simTime)),
  };
  const prevBest = storage.getBest();
  const isRecord = result.score > 0 && result.score > prevBest;
  if (isRecord) storage.setBest(result.score);
  const best = Math.max(prevBest, result.score);
  app.best = best;
  app.hud.setBest(best);
  app.panel.show(result, { best, isRecord });
}

// 게임오버 판정용 목록. overSince 는 Matter 바디에 남아야 하므로 판정 뒤 되돌려 쓴다.
function checkOverflow(app) {
  const items = app.physics.bodies().map((body) => ({
    body,
    y: body.position.y,
    radius: FRUITS[body.level].radius,
    bornAt: body.bornAt,
    overSince: body.overSince,
  }));
  const over = app.game.checkOverflow(items, app.simTime);
  for (const item of items) item.body.overSince = item.overSince;
  return over;
}

// 물리 한 스텝. 시뮬레이션 시간은 스텝 수로 계산해 부동소수점 누적 오차를 피한다.
function stepOnce(app) {
  app.steps += 1;
  app.simTime = app.steps * TIMING.step;
  app.physics.step(TIMING.step, app.simTime);
  app.game.update(app.simTime);
  if (checkOverflow(app)) handleGameOver(app);
}

function advanceSimulation(app, dtMs) {
  if (!app.game.isPlaying) {
    app.acc = 0;
    return;
  }
  app.acc += dtMs;
  while (app.acc >= TIMING.step && app.game.isPlaying) {
    stepOnce(app);
    app.acc -= TIMING.step;
  }
  if (!app.game.isPlaying) app.acc = 0;
}

function buildFrame(app, now) {
  const { game, physics, simTime } = app;
  const bodies = physics.bodies().map((b) => ({
    x: b.position.x,
    y: b.position.y,
    angle: b.angle,
    level: b.level,
    popAge: simTime - b.mergedAt, // 합쳐진 적 없으면 -(-Infinity) = Infinity
  }));
  const held = game.state === 'READY' ? { x: heldX(app), level: game.current } : null;
  return { now, time: simTime, state: game.state, bodies, held, danger: game.danger };
}

function frame(app, now) {
  app.raf = requestAnimationFrame((t) => frame(app, t));
  const dt = app.last === null ? 0 : clamp(now - app.last, 0, MAX_FRAME_MS);
  app.last = now;
  if (!app.paused) advanceSimulation(app, dt);
  app.input.update(dt);
  app.renderer.draw(buildFrame(app, now));
}

// ───────────────────────── 부트스트랩 ─────────────────────────

function setupAudio(app) {
  const { dom, audio, hud } = app;

  function applyMuted(muted, persist) {
    audio.setMuted(muted);
    if (persist) storage.setMuted(muted);
    hud.setMuted(muted);
  }
  applyMuted(storage.getMuted(), false);

  dom.btnMute.addEventListener('click', (e) => {
    applyMuted(!audio.isMuted(), true);
    // 마우스/터치로 눌렀다면 포커스를 풀어, 이어서 스페이스가 음소거 버튼을 누르지 않고 드롭이 되게 한다.
    if (e.detail > 0) dom.btnMute.blur();
  });

  // 브라우저 정책상 오디오는 사용자 제스처 안에서 풀어야 한다(iOS 는 pointerdown 만으로는 부족할 수 있어 여러 이벤트에 건다).
  for (const type of ['pointerdown', 'pointerup', 'keydown', 'click']) {
    document.addEventListener(type, () => audio.unlock(), { once: true, capture: true });
  }
  document.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('button')) audio.play('click');
  });
}

function setupResize(app) {
  let pending = false;
  const resize = () => {
    pending = false;
    app.renderer.resize();
    app.renderer.drawNext(app.game.next);
  };
  // ResizeObserver 콜백 안에서 크기를 바꾸면 루프 경고가 나므로 다음 프레임으로 미룬다.
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(resize);
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(app.dom.stage);
  resize();
}

function setupInput(app) {
  const { dom } = app;
  app.input = createInput({
    canvas: dom.gameCanvas,
    clientToWorld: (cx, cy) => app.renderer.clientToWorld(cx, cy),
    getAimX: () => heldX(app),
    onAim: (x) => void (app.aimX = x),
    onDrop: () => dropFruit(app),
    isBlocked: () => isOverlayOpen(dom),
  });
}

// ?debug 일 때만 노출하는 테스트용 훅. 시뮬레이션을 결정적으로 제어한다.
function installDebugHook(app) {
  const summarize = (b) => ({
    id: b.id,
    level: b.level,
    x: b.position.x,
    y: b.position.y,
    angle: b.angle,
    vx: b.velocity.x,
    vy: b.velocity.y,
  });

  window.__fruit = {
    game: app.game,
    physics: app.physics,
    spawn: (level, x, y) => summarize(app.physics.spawn(level, x, y, app.simTime)),
    bodies: () => app.physics.bodies().map(summarize),
    pause() {
      app.paused = true;
    },
    resume() {
      app.paused = false;
      app.acc = 0;
      app.last = null;
    },
    // 일시정지 중에도 ms 만큼(스텝 단위로 반올림) 결정적으로 진행한다. 진행한 뒤의 시뮬레이션 시간을 돌려준다.
    advance(ms) {
      const n = Math.round(ms / TIMING.step);
      for (let i = 0; i < n && app.game.isPlaying; i++) stepOnce(app);
      return app.simTime;
    },
    // 시작 전이면 먼저 판을 시작한 뒤 즉시 끝낸다.
    forceGameOver() {
      if (app.game.state === 'IDLE') startGame(app);
      if (app.game.isPlaying) {
        app.game.endGame(app.simTime);
        handleGameOver(app);
      }
      return app.game.state;
    },
    getState: () => app.game.state,
    getScore: () => app.game.score,
  };
}

function bootstrap() {
  const dom = queryDom();
  const hud = createHud(dom);
  const ranking = createRankingLoader();

  buildEvolutionList(dom.evolutionList);
  hud.setBest(storage.getBest());
  hud.setScore(0);

  const app = {
    dom,
    hud,
    ranking,
    audio: createAudio(),
    game: createGame(),
    panel: createResultPanel({ dom, ranking }),
    renderer: null,
    physics: null,
    input: null,
    simTime: 0,
    steps: 0,
    acc: 0,
    last: null,
    raf: 0,
    paused: false,
    aimX: WORLD.width / 2,
    best: storage.getBest(),
  };

  // 물리 엔진이 없어도 음소거/랭킹 보기는 동작하게 먼저 연결한다.
  setupAudio(app);
  setupRankingOverlay(app);

  if (typeof Matter === 'undefined') {
    showStartError(dom, MSG.noEngine);
    dom.btnStart.disabled = true;
    return;
  }

  app.renderer = createRenderer(dom.gameCanvas, dom.nextCanvas);
  app.physics = createPhysics({ onMerge: (evt) => handleMerge(app, evt) });
  setupInput(app);
  setupResize(app);

  dom.btnStart.addEventListener('click', () => startGame(app));
  dom.btnRestart.addEventListener('click', () => startGame(app));
  document.addEventListener('visibilitychange', () => void (app.last = null));
  if (location.search.includes('debug')) installDebugHook(app);

  resubmitPending().catch(() => {});
  if (prefersFinePointer()) focusSoft(dom.btnStart);
  app.raf = requestAnimationFrame((t) => frame(app, t));
}

try {
  bootstrap();
} catch (err) {
  console.error(err);
  const dom = queryDom();
  if (dom.startError) showStartError(dom, MSG.initFailed);
  if (dom.btnStart) dom.btnStart.disabled = true;
}
