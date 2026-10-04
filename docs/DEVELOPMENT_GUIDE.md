# 🍉 수박 합치기 — 개발 가이드

> 같은 과일을 합쳐 더 큰 과일로 만들고, 상자 밖으로 넘치기 전에 **수박**을 완성하는 퍼즐 게임.
> 기술 스택: **HTML5 Canvas + JavaScript(프런트엔드)** / **Google Apps Script + Google Sheets(랭킹 백엔드)**

이 문서는 구현을 시작하기 전에 "무엇을, 어떤 순서로, 어떤 기준으로 만들지"를 정리한 가이드입니다.
수치(크기·점수·시간)는 모두 **초기값**이며 플레이테스트를 거치며 조정합니다.

---

## 목차

1. [게임 개요와 규칙](#1-게임-개요와-규칙)
2. [아키텍처](#2-아키텍처)
3. [프로젝트 구조](#3-프로젝트-구조)
4. [개발 환경](#4-개발-환경)
5. [게임 설계 상세](#5-게임-설계-상세)
6. [프런트엔드 구현 가이드](#6-프런트엔드-구현-가이드)
7. [Google Apps Script 백엔드](#7-google-apps-script-백엔드)
8. [프런트 ↔ GAS 연동](#8-프런트--gas-연동)
9. [개발 로드맵(마일스톤)](#9-개발-로드맵마일스톤)
10. [테스트 체크리스트](#10-테스트-체크리스트)
11. [배포](#11-배포)
12. [보안과 주의사항](#12-보안과-주의사항)
13. [열린 결정사항](#13-열린-결정사항)

---

## 1. 게임 개요와 규칙

| 항목 | 내용 |
|---|---|
| 목표 | 같은 과일 2개를 합쳐 더 큰 과일을 만들어 **수박**을 완성한다 |
| 패배 조건 | 과일이 상자 위쪽 경계선을 넘은 채로 일정 시간 머문다 |
| 조작 | 좌우로 위치를 정하고 **탭/클릭/스페이스**로 과일을 떨어뜨린다 |
| 합치기 | 같은 종류의 과일이 닿으면 두 과일이 사라지고, 접촉 지점 중간에 **한 단계 큰 과일**이 생긴다 |
| 점수 | 합쳐서 새 과일이 만들어질 때마다 그 과일의 점수를 얻는다 |

### 진화 단계 (11단계)

| Lv | 과일 | 반지름(px) | 합쳐서 얻는 점수 | 떨어뜨릴 수 있나 |
|---:|---|---:|---:|:---:|
| 0 | 🍒 체리 | 16 | 1 | ✅ |
| 1 | 🍓 딸기 | 22 | 3 | ✅ |
| 2 | 🍇 포도 | 30 | 6 | ✅ |
| 3 | 🍊 데코폰 | 36 | 10 | ✅ |
| 4 | 🟠 감 (임시 아이콘) | 44 | 15 | ✅ |
| 5 | 🍎 사과 | 54 | 21 | ❌ |
| 6 | 🍐 배 | 64 | 28 | ❌ |
| 7 | 🍑 복숭아 | 76 | 36 | ❌ |
| 8 | 🍍 파인애플 | 88 | 45 | ❌ |
| 9 | 🍈 멜론 | 100 | 55 | ❌ |
| 10 | 🍉 수박 | 116 | 66 | ❌ |

- 점수 공식: `score(level) = (level + 1)(level + 2) / 2`
- 떨어뜨릴 과일은 **Lv 0~4 중 무작위**, 다음 과일(Next)을 미리 보여준다.
- 수박 2개가 닿으면 둘 다 사라지고 보너스 점수를 준다 (기본값 +100, [§13](#13-열린-결정사항) 참고).

---

## 2. 아키텍처

```
┌──────────────────────────┐        fetch (GET/POST)        ┌─────────────────────────┐
│  브라우저 (정적 HTML/JS)   │ ─────────────────────────────▶ │ Google Apps Script       │
│  - Canvas 렌더링          │                                │ Web App (doGet/doPost)   │
│  - Matter.js 물리         │ ◀───────────────────────────── │  - 점수 검증             │
│  - 게임 로직/UI           │          JSON 응답             │  - 랭킹 조회/저장         │
└──────────────────────────┘                                └───────────┬─────────────┘
        ▲  GitHub Pages로 호스팅                                          │
        │                                                      ┌──────────▼──────────┐
        └─ localStorage: 최고점수, 닉네임, 설정                   │ Google Sheets        │
                                                               │  (scores 시트)       │
                                                               └─────────────────────┘
```

### 역할 분담

| 영역 | 역할 |
|---|---|
| **프런트엔드** | 게임의 모든 로직(물리, 합치기, 점수, 게임오버). 서버 없이도 단독 플레이 가능해야 한다 |
| **Google Apps Script** | 랭킹 저장/조회 API. 게임 로직은 서버에 두지 않는다 |
| **Google Sheets** | 점수 데이터 저장소 (DB 대용) |

### 호스팅 방식 선택

| | A. GitHub Pages + GAS API **(권장)** | B. GAS `HtmlService`로 HTML까지 서빙 |
|---|---|---|
| 장점 | Git 중심 개발, 로딩 빠름, 로컬 개발 쉬움, CORS 구조가 단순 | 배포 대상이 하나 |
| 단점 | 배포 대상이 둘(페이지 + GAS) | iframe 샌드박스 제약, `google.script.run` 의존, 로컬 테스트 불편, 로딩이 느림 |

**이 가이드는 A를 기준으로 합니다.**

---

## 3. 프로젝트 구조

빌드 도구 없이 **정적 파일 + ES Modules**로 구성합니다. (번들러가 필요 없으므로 진입 장벽이 낮고 GitHub Pages에 그대로 올릴 수 있음)

```
seongmo--fruit/
├─ index.html              # 진입점: 캔버스, HUD, 모달 마크업
├─ css/
│  └─ style.css
├─ js/
│  ├─ config.js            # 상수: 과일 정의, 월드 크기, 점수 규칙, API_URL
│  ├─ main.js              # 부트스트랩, 게임 루프, 상태 머신
│  ├─ physics.js           # Matter.js 월드/벽/과일 생성, 충돌 → 합치기 큐
│  ├─ game.js              # 점수, 다음 과일, 게임오버 판정 (렌더/DOM 비의존)
│  ├─ render.js            # Canvas 그리기 (과일, 가이드라인, 이펙트)
│  ├─ input.js             # 포인터/키보드 입력
│  ├─ audio.js             # 효과음
│  ├─ storage.js           # localStorage 래퍼 (try/catch 포함)
│  └─ api.js               # GAS 통신 (랭킹 조회/점수 제출)
├─ assets/
│  ├─ fruits/              # 과일 스프라이트 (초기엔 비워두고 이모지 사용)
│  └─ sounds/
├─ gas/
│  ├─ Code.gs              # Apps Script 소스 (clasp로 동기화)
│  └─ appsscript.json
└─ docs/
   └─ DEVELOPMENT_GUIDE.md
```

**모듈 의존 원칙**

- `game.js`는 DOM/Canvas를 모른다 → 단위 테스트와 규칙 변경이 쉬워진다.
- `config.js`의 수치만 바꿔서 밸런스를 조정할 수 있어야 한다.
- 네트워크 호출은 `api.js`에만 둔다. 실패해도 게임은 계속 돌아가야 한다.

---

## 4. 개발 환경

### 로컬 실행

ES Module은 `file://`로 열면 동작하지 않으므로 로컬 서버가 필요합니다.

```bash
# 프로젝트 루트에서
python3 -m http.server 8000
# → http://localhost:8000
```

모바일 실기기 테스트는 같은 Wi-Fi에서 `http://<PC의 IP>:8000`으로 접속합니다.

### 의존 라이브러리

| 라이브러리 | 용도 | 비고 |
|---|---|---|
| [Matter.js](https://brm.io/matter-js/) | 2D 물리 엔진 (원형 충돌, 중력, 쌓임) | CDN으로 로드, **버전 고정** (예: `0.19.0`) |

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.19.0/matter.min.js"></script>
```

> 물리 엔진을 직접 만들지 않는 이유: 원이 쌓이고 굴러서 안정되는 동작(접촉 해소, 슬립)을 직접 구현하면 비용이 크고 불안정합니다. Matter.js는 이 용도에 충분합니다.

### GAS 개발 (선택: clasp)

Apps Script 편집기에서 직접 수정해도 되지만, 코드를 저장소로 관리하려면 [clasp](https://github.com/google/clasp)를 사용합니다.

```bash
npm i -g @google/clasp
clasp login
clasp clone <SCRIPT_ID> --rootDir gas   # 기존 스크립트를 gas/ 로 가져오기
clasp push                              # 로컬 → Apps Script 반영
```

---

## 5. 게임 설계 상세

### 5.1 월드와 좌표

- **논리 좌표계는 고정**(`400 × 600`)하고, 화면 크기에 맞춰 캔버스를 **스케일**한다. 물리는 항상 논리 좌표에서 계산하므로 기기마다 게임 난이도가 달라지지 않는다.
- 상자는 바닥 + 좌/우 벽(정적 바디). 위쪽은 열려 있다.
- **경계선(DANGER_Y)** = 상자 위에서 약 `100px` 아래. 점선으로 표시한다.
- 과일은 경계선 위쪽 **스폰 영역**(y ≈ 50)에서 대기하다가 떨어진다.

### 5.2 상태 머신

```
        ┌───────── 쿨다운 종료 ─────────┐
        ▼                               │
   [READY] ──드롭──▶ [COOLDOWN] ────────┘
     │                    │
     └──── 게임오버 조건 ──┴──▶ [GAME_OVER] ──재시작──▶ [READY]
```

| 상태 | 설명 |
|---|---|
| `READY` | 현재 과일이 포인터 x를 따라다님. 입력 시 드롭 |
| `COOLDOWN` | 드롭 직후 약 500ms. 입력 무시, 다음 과일 준비 |
| `GAME_OVER` | 물리 정지, 결과 모달, 점수 제출/랭킹 표시 |

### 5.3 합치기 규칙

1. 두 바디가 충돌했고, **둘 다 과일이며, 같은 `level`이고, 아직 `merging`이 아니면** 합치기 대상.
2. 두 바디에 `merging = true`를 걸어 **중복 합치기를 방지**한다 (한 과일이 동시에 두 쌍에 속하는 경우).
3. 충돌 콜백 안에서 월드를 직접 수정하지 말고 **큐에 넣었다가 물리 스텝 이후에 일괄 처리**한다.
4. 두 과일을 제거하고 **중간 지점**에 `level + 1` 과일을 생성한다. 속도는 두 과일의 평균을 이어받는다.
5. 점수를 더한다. `level === 10`(수박)끼리의 합치기는 둘 다 제거 + 보너스.

### 5.4 게임오버 판정

단순히 "경계선을 넘었다"로 판정하면 **방금 떨어뜨린 과일** 때문에 즉시 패배한다. 두 가지 유예를 둔다.

- **드롭 유예(`SETTLE_GRACE_MS` ≈ 1500ms)**: 드롭/생성 직후의 과일은 판정에서 제외.
- **체류 시간(`OVERFLOW_MS` ≈ 2000ms)**: 경계선을 넘은 상태가 **연속으로** 이 시간 이상 유지되면 게임오버. 중간에 내려가면 타이머 리셋.

### 5.5 밸런스 파라미터 (초기값)

| 파라미터 | 값 | 비고 |
|---|---|---|
| 중력 `gravity.y` | 1.0 (Matter 기본) | 너무 느리면 답답함 |
| 반발 `restitution` | 0.1 | 높으면 튀어서 불안정 |
| 마찰 `friction` | 0.1 | |
| 정지 마찰 `frictionStatic` | 0.5 | 과일이 비탈에서 미끄러지는 정도 |
| 드롭 쿨다운 | 500ms | |
| 드롭 유예 | 1500ms | |
| 경계선 체류 | 2000ms | |
| 고정 타임스텝 | 1000/60 ms | 기기 주사율과 무관하게 동일한 물리 |

---

## 6. 프런트엔드 구현 가이드

### 6.1 과일 정의 (`config.js`)

```js
export const WORLD = { width: 400, height: 600, wall: 20, dangerY: 100, spawnY: 50 };

export const FRUITS = [
  { level: 0,  name: '체리',     radius: 16,  emoji: '🍒', color: '#e53935' },
  { level: 1,  name: '딸기',     radius: 22,  emoji: '🍓', color: '#ec407a' },
  { level: 2,  name: '포도',     radius: 30,  emoji: '🍇', color: '#8e24aa' },
  { level: 3,  name: '데코폰',   radius: 36,  emoji: '🍊', color: '#fb8c00' },
  { level: 4,  name: '감',       radius: 44,  emoji: '🟠', color: '#ef6c00' },
  { level: 5,  name: '사과',     radius: 54,  emoji: '🍎', color: '#d32f2f' },
  { level: 6,  name: '배',       radius: 64,  emoji: '🍐', color: '#c0ca33' },
  { level: 7,  name: '복숭아',   radius: 76,  emoji: '🍑', color: '#ffab91' },
  { level: 8,  name: '파인애플', radius: 88,  emoji: '🍍', color: '#fdd835' },
  { level: 9,  name: '멜론',     radius: 100, emoji: '🍈', color: '#9ccc65' },
  { level: 10, name: '수박',     radius: 116, emoji: '🍉', color: '#43a047' },
];

export const LAST_LEVEL = FRUITS.length - 1;
export const MAX_DROP_LEVEL = 4;            // 떨어뜨릴 수 있는 최대 단계
export const scoreOf = (level) => ((level + 1) * (level + 2)) / 2;
export const WATERMELON_PAIR_BONUS = 100;

export const TIMING = {
  step: 1000 / 60,
  dropCooldown: 500,
  settleGrace: 1500,
  overflow: 2000,
};
```

> **이모지 → 스프라이트 전환**: 이모지는 OS마다 모양이 다르고 크기 제어가 어렵습니다. 프로토타입은 이모지로 빠르게 만들고, 렌더러가 `FRUITS[i].sprite`가 있으면 이미지를, 없으면 이모지를 그리도록 만들어 두면 나중에 `config.js`만 수정해 교체할 수 있습니다.

### 6.2 물리 월드 (`physics.js`)

```js
import { WORLD, FRUITS, LAST_LEVEL } from './config.js';

const { Engine, Bodies, Body, Composite, Events } = Matter;
const { width: W, height: H, wall } = WORLD;

const engine = Engine.create({ gravity: { y: 1 } });
const world = engine.world;
const mergeQueue = [];

// 벽: 바닥 + 좌/우 (정적 바디)
Composite.add(world, [
  Bodies.rectangle(W / 2, H + wall / 2, W + wall * 2, wall, { isStatic: true }),
  Bodies.rectangle(-wall / 2, H / 2, wall, H * 2, { isStatic: true }),
  Bodies.rectangle(W + wall / 2, H / 2, wall, H * 2, { isStatic: true }),
]);

export function spawnFruit(level, x, y, velocity) {
  const body = Bodies.circle(x, y, FRUITS[level].radius, {
    restitution: 0.1, friction: 0.1, frictionStatic: 0.5,
  });
  body.isFruit = true;
  body.level = level;
  body.merging = false;
  body.bornAt = performance.now();
  if (velocity) Body.setVelocity(body, velocity);
  Composite.add(world, body);
  return body;
}

// 충돌은 '표시'만 하고, 실제 변경은 스텝 뒤에 한다
function onCollide(e) {
  for (const { bodyA: a, bodyB: b } of e.pairs) {
    if (!a.isFruit || !b.isFruit) continue;
    if (a.level !== b.level || a.merging || b.merging) continue;
    a.merging = b.merging = true;
    mergeQueue.push([a, b]);
  }
}
Events.on(engine, 'collisionStart', onCollide);
Events.on(engine, 'collisionActive', onCollide); // 겹친 채로 생성된 경우 대비

export function flushMerges(onMerged) {
  for (const [a, b] of mergeQueue) {
    const x = (a.position.x + b.position.x) / 2;
    const y = (a.position.y + b.position.y) / 2;
    const level = a.level;
    const velocity = {
      x: (a.velocity.x + b.velocity.x) / 2,
      y: (a.velocity.y + b.velocity.y) / 2,
    };
    Composite.remove(world, [a, b]);
    if (level === LAST_LEVEL) {
      onMerged({ level, x, y, bonus: true });
    } else {
      spawnFruit(level + 1, x, y, velocity);
      onMerged({ level: level + 1, x, y, bonus: false });
    }
  }
  mergeQueue.length = 0;
}
```

**주의할 점**

- `collisionActive`도 구독하지 않으면, 합쳐진 과일이 이웃과 겹쳐서 태어났을 때 합치기가 누락될 수 있다.
- 새로 생긴 큰 과일이 이웃을 밀어내며 연쇄 합치기가 일어나는 것은 **정상 동작**이다(콤보). 막지 않는다.
- 드롭 전 대기 중인 과일은 물리 바디가 아니라 **렌더링용 객체**로만 둔다. 드롭하는 순간 `spawnFruit`으로 바디를 만든다.

### 6.3 게임 루프 (`main.js`)

렌더링과 물리를 분리하고, 물리는 **고정 타임스텝**으로 돌려 주사율(60/120/144Hz)과 무관하게 결과가 같도록 한다.

```js
let last = performance.now();
let acc = 0;

function frame(now) {
  acc += Math.min(now - last, 100);   // 탭 전환 후 복귀 시 폭주 방지
  last = now;

  while (acc >= TIMING.step) {
    Engine.update(engine, TIMING.step);
    flushMerges(handleMerged);        // 점수, 이펙트, 효과음
    acc -= TIMING.step;
  }

  if (state === 'READY' || state === 'COOLDOWN') checkGameOver(now);
  render(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

### 6.4 게임오버 판정 (`game.js`)

```js
export function checkGameOver(fruits, now) {
  for (const f of fruits) {
    if (now - f.bornAt < TIMING.settleGrace) { f.overSince = null; continue; }
    const top = f.position.y - FRUITS[f.level].radius;
    if (top < WORLD.dangerY) {
      f.overSince ??= now;
      if (now - f.overSince >= TIMING.overflow) return true;
    } else {
      f.overSince = null;
    }
  }
  return false;
}
```

경계선을 넘기 직전(체류 시간의 50% 이상)에는 경계선을 **붉게 깜빡여** 플레이어에게 경고한다.

### 6.5 입력 (`input.js`)

- **Pointer Events**(`pointerdown/move/up`) 하나로 마우스와 터치를 함께 처리한다.
- 캔버스에 CSS `touch-action: none;` — 안 쓰면 모바일에서 스크롤/확대가 끼어든다.
- 포인터 x는 **캔버스 좌표 → 논리 좌표**로 변환한 뒤, 현재 과일이 벽을 뚫지 않도록 `[wall + r, W - wall - r]`로 clamp한다.
- 모바일은 `pointermove`로 위치를 잡고 **`pointerup`에서 드롭**하는 방식이 손가락에 과일이 가려지는 문제를 줄여준다.
- 데스크톱 보조: `← →` 이동, `Space` 드롭.

### 6.6 렌더링 (`render.js`)

- `devicePixelRatio`를 반영해 캔버스 내부 해상도를 키우고, CSS 크기로 줄여 보여준다 (레티나에서 흐려지지 않게).
- 그리는 순서: 배경 → 상자/경계선 → 과일 → 대기 중인 과일 + 낙하 가이드선 → 이펙트 → HUD.
- 합치기 이펙트: 새 과일을 `scale 0.8 → 1.1 → 1.0`으로 150ms 튀게(렌더 전용 스케일, 물리 반지름은 즉시 확정) + 파티클 몇 개.
- Next 과일, 현재 점수, 최고 점수는 DOM(HUD) 또는 캔버스 중 편한 쪽에 표시한다. DOM이면 접근성/반응형이 쉽다.

### 6.7 반응형/모바일

- 레이아웃은 **세로 모바일 우선**. 게임 영역 비율 `2:3`을 유지하며 화면에 맞춰 축소.
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
- iOS Safari는 사용자 제스처 전까지 오디오가 막힌다 → **첫 터치에서 AudioContext를 resume**.
- 더블탭 확대, 길게 눌러 선택/컨텍스트 메뉴가 뜨지 않게 `user-select: none` 등을 적용.

### 6.8 저장 (`storage.js`)

최고 점수와 닉네임, 음소거 설정은 `localStorage`에 저장한다. 사생활 보호 모드 등에서 접근이 **예외를 던질 수 있으므로** 모든 읽기/쓰기를 `try/catch`로 감싸고, 실패해도 게임은 정상 동작해야 한다.

---

## 7. Google Apps Script 백엔드

### 7.1 시트 구성

스프레드시트를 새로 만들고 시트 이름을 `scores`로 한 뒤 1행에 헤더를 둔다.

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| `timestamp` | `nickname` | `score` | `maxLevel` | `playTimeMs` | `drops` |

스프레드시트 ID(URL의 `/d/<ID>/edit`)는 **프로젝트 설정 → 스크립트 속성**에 `SHEET_ID`로 저장한다.

### 7.2 API 명세

| 메서드 | 요청 | 응답 |
|---|---|---|
| `GET` | `?action=ranking&limit=10` | `{ ok: true, data: [{ nickname, score, maxLevel, at }] }` |
| `POST` | 본문(JSON 문자열): `{ nickname, score, maxLevel, playTimeMs, drops }` | `{ ok: true }` 또는 `{ ok: false, error: "<코드>" }` |

에러 코드: `bad_request`, `invalid_nickname`, `invalid_score`, `implausible`, `server_busy`

### 7.3 `Code.gs`

```js
const SHEET_NAME = 'scores';
const MAX_NICKNAME = 12;
const MAX_SCORE = 100000;
const MAX_SCORE_PER_DROP = 300;   // 초기값. 플레이테스트 로그를 보고 조정
const MIN_MS_PER_DROP = 400;      // 드롭 쿨다운(500ms)보다 약간 느슨하게
const RANKING_CACHE_KEY = 'ranking';
const RANKING_CACHE_SEC = 60;
const RANKING_KEEP = 50;

function doGet(e) {
  const p = (e && e.parameter) || {};
  if ((p.action || 'ranking') === 'ranking') {
    const limit = Math.min(Math.max(Number(p.limit) || 10, 1), RANKING_KEEP);
    return json_({ ok: true, data: getRanking_().slice(0, limit) });
  }
  return json_({ ok: false, error: 'bad_request' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    return json_(submitScore_(body));
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
}

function submitScore_(b) {
  const nickname = sanitizeNickname_(b.nickname);
  const score = Number(b.score);
  const maxLevel = Number(b.maxLevel);
  const playTimeMs = Number(b.playTimeMs);
  const drops = Number(b.drops);

  if (!nickname) return { ok: false, error: 'invalid_nickname' };
  if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
    return { ok: false, error: 'invalid_score' };
  }
  if (!isPlausible_(score, drops, playTimeMs)) {
    return { ok: false, error: 'implausible' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, error: 'server_busy' };
  try {
    sheet_().appendRow([new Date(), nickname, score, maxLevel, playTimeMs, drops]);
    CacheService.getScriptCache().remove(RANKING_CACHE_KEY);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function getRanking_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(RANKING_CACHE_KEY);
  if (hit) return JSON.parse(hit);

  const rows = sheet_().getDataRange().getValues().slice(1)   // 헤더 제외
    .map(r => ({ nickname: r[1], score: r[2], maxLevel: r[3], at: new Date(r[0]).getTime() }))
    .sort((a, b) => b.score - a.score)
    .slice(0, RANKING_KEEP);

  cache.put(RANKING_CACHE_KEY, JSON.stringify(rows), RANKING_CACHE_SEC);
  return rows;
}

// ── 유틸 ─────────────────────────────────────────────

function sheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return SpreadsheetApp.openById(id).getSheetByName(SHEET_NAME);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sanitizeNickname_(raw) {
  let s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')   // 제어문자 제거
    .trim()
    .slice(0, MAX_NICKNAME);
  if (!s) return '';
  if (/^[=+\-@]/.test(s)) s = "'" + s;       // 시트 수식 인젝션 방지
  return s;
}

function isPlausible_(score, drops, playTimeMs) {
  if (!Number.isFinite(drops) || !Number.isFinite(playTimeMs)) return false;
  if (drops < 1 || playTimeMs < drops * MIN_MS_PER_DROP) return false;
  return score <= drops * MAX_SCORE_PER_DROP;
}
```

### 7.4 배포 절차

1. 스프레드시트 생성 → `scores` 시트 + 헤더 입력.
2. **확장 프로그램 → Apps Script** 에서 `Code.gs` 붙여넣기, 스크립트 속성에 `SHEET_ID` 등록.
3. **배포 → 새 배포 → 유형: 웹 앱**
   - 실행 사용자: **나**
   - 액세스 권한: **모든 사용자** (프런트가 로그인 없이 호출해야 함)
4. 최초 1회 권한 승인 후 발급되는 `…/exec` URL을 `js/config.js`의 `API_URL`에 넣는다.
5. 동작 확인:

```bash
curl -L "https://script.google.com/macros/s/<DEPLOY_ID>/exec?action=ranking&limit=5"
```

> ⚠️ **코드를 수정했을 때** "새 배포"를 만들면 URL이 바뀝니다. **배포 관리 → 편집(연필) → 버전: 새 버전 → 배포**로 같은 URL을 유지하세요.
> ⚠️ 웹 앱은 **저장된 코드가 아니라 "배포된 버전"** 을 실행합니다. 수정 후 재배포를 잊으면 반영되지 않습니다.

---

## 8. 프런트 ↔ GAS 연동

### 8.1 CORS 규칙 (가장 흔한 함정)

Apps Script 웹 앱은 **CORS preflight(OPTIONS)를 처리하지 못합니다.** 따라서:

- `GET`은 그대로 `fetch` 가능.
- `POST`는 `Content-Type: application/json`을 쓰면 preflight가 발생해 **실패**한다. → **`text/plain`으로 보내고 본문에 JSON 문자열**을 담는다 (서버에서 `JSON.parse(e.postData.contents)`로 해석).
- 커스텀 헤더(`Authorization` 등)를 붙이지 않는다.

### 8.2 `api.js`

```js
import { API_URL } from './config.js';

const TIMEOUT_MS = 8000;

async function request(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function fetchRanking(limit = 10) {
  return request(`${API_URL}?action=ranking&limit=${limit}`);
}

export function submitScore({ nickname, score, maxLevel, playTimeMs, drops }) {
  return request(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },  // preflight 회피
    body: JSON.stringify({ nickname, score, maxLevel, playTimeMs, drops }),
  });
}
```

### 8.3 UX 원칙

- GAS는 **콜드 스타트로 1~3초** 걸릴 수 있다. 게임 진행을 막지 말고, 결과 화면에서 "랭킹 불러오는 중…" 상태를 보여준다.
- 제출 실패(네트워크/`server_busy`) 시 **재시도 버튼**을 제공하고, 점수는 `localStorage`에 임시 보관한다.
- `API_URL`이 비어 있거나 호출이 실패해도 **오프라인 모드(최고 점수만)** 로 정상 플레이되어야 한다.
- 닉네임/랭킹 데이터를 DOM에 넣을 때는 **`textContent`** 를 사용한다 (`innerHTML` 금지 → XSS 방지).
- 점수 제출은 **게임오버 때 1회**. 제출 버튼을 누른 뒤에는 비활성화해 중복 제출을 막는다.

---

## 9. 개발 로드맵(마일스톤)

각 마일스톤은 독립적으로 동작을 확인할 수 있는 단위이며, **하나 끝날 때마다 커밋**합니다.

| # | 마일스톤 | 작업 | 완료 기준 (DoD) |
|---|---|---|---|
| M0 | 프로젝트 세팅 | 폴더 구조, `index.html`, Matter.js 로드, 로컬 서버 | 빈 캔버스가 뜨고 콘솔 에러 없음 |
| M1 | 물리 프로토타입 | 상자, 클릭 위치에 과일 드롭, 렌더링 | 과일이 떨어져 쌓이고 벽을 뚫지 않음 |
| M2 | 합치기 | 충돌 → 합치기 큐 → 다음 단계 생성, 11단계 정의 | 같은 과일이 합쳐지고 수박까지 도달 가능, 중복 합치기 없음 |
| M3 | 게임 규칙 | 점수, Next 미리보기, 쿨다운, 경계선, 게임오버, 재시작 | 한 판이 시작→종료→재시작까지 완결됨 |
| M4 | UI/UX | HUD, 모바일 터치, 반응형 스케일, 결과 모달, 최고점 저장 | 스마트폰 세로 화면에서 불편 없이 플레이 |
| M5 | GAS 랭킹 | 시트 + `Code.gs` 배포, `api.js`, 닉네임 입력, 랭킹 표시 | 점수 제출 후 랭킹에 반영, 서버 장애에도 게임 정상 |
| M6 | 폴리싱 | 효과음/BGM 토글, 합치기 이펙트, 스프라이트 교체, 수박 완성 연출 | 체감 품질 개선, 성능 저하 없음 |
| M7 | 배포 | GitHub Pages, README, 최종 QA | 공개 URL에서 end-to-end 동작 |

> 우선순위: **M1~M3(재미의 핵심)을 먼저 완성**하고 실제로 해본 뒤 M4 이후로 넘어갑니다. 합치기의 손맛과 밸런스가 안 나오면 이후 작업은 의미가 없습니다.

---

## 10. 테스트 체크리스트

자동화 테스트보다 **수동 플레이 점검**이 중심입니다. 다만 `game.js`의 순수 로직(점수 계산, 게임오버 판정)은 가볍게 단위 테스트할 수 있습니다.

**물리/합치기**
- [ ] 같은 과일 2개가 닿으면 정확히 1개의 상위 과일이 생긴다 (중복 생성 없음)
- [ ] 3개가 한꺼번에 닿아도 2개만 합쳐지고 나머지 1개는 남는다
- [ ] 합쳐진 과일이 이웃과 겹쳐도 연쇄 합치기가 정상 동작한다
- [ ] 수박 2개 → 소멸 + 보너스 점수
- [ ] 과일이 벽/바닥을 뚫고 나가지 않는다 (빠르게 떨어뜨려도)
- [ ] 60Hz / 120Hz 모니터에서 물리 속도가 동일하다

**게임 규칙**
- [ ] 드롭 직후 과일이 경계선 위에 있어도 게임오버가 되지 않는다
- [ ] 경계선을 넘은 채 2초 유지되면 게임오버, 도중에 내려가면 취소된다
- [ ] 쿨다운 중 입력이 무시된다
- [ ] 재시작 시 이전 판의 바디/타이머/점수가 남아 있지 않다
- [ ] 탭을 백그라운드로 보냈다 돌아와도 물리가 폭주하지 않는다

**UI/기기**
- [ ] iOS Safari / Android Chrome / 데스크톱 Chrome에서 입력이 동작한다
- [ ] 화면 회전·창 크기 변경 시 캔버스가 올바르게 스케일된다
- [ ] 스크롤/확대/길게 누르기 메뉴가 게임 조작을 방해하지 않는다
- [ ] 오디오가 첫 터치 이후 재생된다

**백엔드**
- [ ] 정상 제출 → 시트에 한 행이 추가되고 랭킹에 반영된다
- [ ] 빈 닉네임, 긴 닉네임, `=1+1` 같은 닉네임 처리
- [ ] 음수/비정수/과도한 점수, 드롭 수와 맞지 않는 점수 → 거부
- [ ] 동시에 여러 번 제출해도 행이 유실/중복되지 않는다
- [ ] `API_URL` 미설정, 네트워크 차단 상태에서도 게임이 플레이된다

---

## 11. 배포

### 프런트엔드 → GitHub Pages

1. 저장소 **Settings → Pages**
2. Source: `Deploy from a branch`, Branch: `main` / `(root)`
3. `https://<계정>.github.io/<저장소>/` 로 접속 확인
4. 상대 경로(`./js/main.js`, `./assets/...`)만 사용해 서브 경로에서도 동작하게 한다.

### 백엔드 → Apps Script 웹 앱

[§7.4](#74-배포-절차) 참고. 프런트 배포 후 `API_URL`이 올바른지 **실제 공개 URL에서** 한 번 더 확인합니다.

### 릴리스 전 최종 점검

- [ ] 콘솔에 에러/경고 없음
- [ ] `API_URL`이 운영 배포 URL
- [ ] 시트에 테스트 데이터 정리
- [ ] 모바일 실기기에서 한 판 완주

---

## 12. 보안과 주의사항

**클라이언트가 보내는 점수는 신뢰할 수 없습니다.** 정적 프런트 + GAS 구조에서는 개발자 도구로 점수를 위조하는 것을 완전히 막을 수 없습니다. 목표는 "막는 것"이 아니라 **"쉽게 망가지지 않게 하는 것"** 입니다.

| 단계 | 대책 | 비고 |
|---|---|---|
| 기본 (M5) | 서버에서 형식/범위 검증, 닉네임 정제, 점수 상한, `playTimeMs`·`drops` 대비 점수 타당성 검사 | §7.3에 포함 |
| 보강 | 판 시작 시 서버가 **세션 토큰** 발급 → 제출 시 토큰 + 경과 시간 검증, 토큰 1회용 | 랭킹이 공개되어 어뷰징이 보일 때 |
| 보강 | `CacheService`로 `clientId`/IP 대용 키 기준 **제출 빈도 제한** | |
| 운영 | 시트에서 이상 행을 수동 삭제 → 캐시 만료(최대 60초) 후 반영 | |

**기타 주의**

- 스프레드시트는 **공유하지 않는다** (스크립트가 "나" 권한으로 접근하므로 공개할 필요 없음). 랭킹은 GAS API로만 노출한다.
- 시트에 쓰는 문자열은 수식 인젝션(`= + - @` 시작)을 막는다 → §7.3 `sanitizeNickname_`.
- 화면에 출력할 때는 `textContent` 사용 (XSS).
- GAS는 호출 횟수·동시 실행에 **쿼터**가 있다. 랭킹은 캐시(60초)를 쓰고, 프런트는 결과 화면에서만 호출한다.
- `API_URL`(배포 ID)은 공개되어도 되는 값이지만, **스프레드시트 ID나 다른 비밀 값은 프런트 코드에 넣지 않는다.**

---

## 13. 열린 결정사항

아래는 가이드가 **임시로 정해 둔 기본값**입니다. 바꾸고 싶은 항목이 있으면 알려주세요.

| # | 항목 | 기본값 | 대안 |
|---|---|---|---|
| 1 | GAS의 역할 | 랭킹 저장/조회 API | 단순 방문 통계, 또는 GAS에서 HTML까지 서빙(옵션 B) |
| 2 | 프런트 호스팅 | GitHub Pages | GAS `HtmlService`, Netlify 등 |
| 3 | 수박을 만들었을 때 | **클리어 연출 후 계속 플레이**(엔드리스) | 즉시 게임 종료/승리 처리 |
| 4 | 수박 + 수박 | 소멸 + 보너스 +100 | 소멸만 / 그대로 두기 |
| 5 | 과일 그래픽 | 이모지(임시) → 이후 스프라이트 | 처음부터 직접 제작한 이미지 사용 |
| 6 | 랭킹 대상 | 닉네임 입력(로그인 없음) | 구글 로그인 연동 |
| 7 | 언어 | 한국어 UI | 다국어 |
| 8 | 감 아이콘 | 🟠 (이모지에 감이 없음) | 스프라이트 제작 시 교체 |

---

### 참고

- Matter.js 문서: https://brm.io/matter-js/docs/
- Apps Script 웹 앱: https://developers.google.com/apps-script/guides/web
- clasp: https://github.com/google/clasp
