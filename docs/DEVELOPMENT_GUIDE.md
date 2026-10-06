# 🍉 수박 합치기 — 개발 가이드

> 같은 과일을 합쳐 더 큰 과일로 만들고, 상자 밖으로 넘치기 전에 **수박**을 완성하는 퍼즐 게임.
> 기술 스택: **HTML5 Canvas + JavaScript(프런트엔드)** / **Google Apps Script + Google Sheets(랭킹 백엔드, 게임 화면 호스팅)**
> 배포: **Apps Script 웹 앱 하나**가 게임 화면과 랭킹을 모두 제공한다 (GitHub Pages 는 선택)

이 문서는 "무엇을, 어떤 순서로, 어떤 기준으로 만들지"를 정리한 가이드이며, 구현이 끝난 뒤 코드에 맞춰 갱신했습니다.
수치(크기·점수·시간)는 모두 **초기값**이며 플레이테스트를 거치며 조정합니다.
**수치와 백엔드 규칙의 단일 출처는 코드입니다**: 게임 수치는 `js/config.js`, 서버 규칙은 `gas/Code.gs`. 이 문서는 그 의도와 이유를 설명하며, 코드를 복사해 두지 않습니다(복사본은 금방 낡습니다). `gas/Index.html` 은 소스가 아니라 `npm run build:gas` 가 만드는 **생성물**입니다([§4](#apps-script-배포용-빌드-npm-run-buildgas)).

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
- 떨어뜨릴 과일은 **Lv 0~4 중 가중치 무작위**(`DROP_WEIGHTS = [30, 28, 20, 14, 8]`, 작은 과일이 더 자주 나온다), 다음 과일(Next)을 미리 보여준다.
- 수박 2개가 닿으면 둘 다 사라지고 보너스 점수를 준다 (기본값 +100, [§13](#13-열린-결정사항) 참고).

---

## 2. 아키텍처

```
 개발: index.html + css/ + js/ ──(npm run build:gas, esbuild)──▶ gas/Index.html (생성물, 한 파일)
                                                                     │ 붙여 넣기 또는 clasp push
                                                                     ▼
 ┌─ 브라우저 ───────────────────┐  ① GET …/exec        ┌─ Apps Script 웹 앱 하나 ─────────────────┐
 │ Google 의 sandbox iframe 안   │ ───────────────────▶ │ doGet(e)  action 없음  → Index.html       │
 │  - 게임 (Canvas + Matter.js)  │ ◀──── Index.html ─── │           action=ranking → JSON (외부용)  │
 │  - api.js                     │                      │ apiRanking(limit) / apiSubmit(payload)    │
 │    └ google.script.run ───────┼─ ② 서버 함수 호출 ─▶ │   └ 검증 · 빈도 제한 · 재전송 · 락 · 캐시    │
 │                               │ ◀── { ok, … } 객체 ─ │ doPost(e)  외부 클라이언트용 JSON          │
 └───────────────────────────────┘                      └───────────────────┬──────────────────────┘
   localStorage: 최고점수, 닉네임, 설정                                       ▼
   (iframe 에서 막히면 메모리로 대체)                                  Google Sheets (scores 시트)
```

①은 웹 앱 주소를 여는 것이고, 이후 화면의 랭킹 조회/점수 제출은 ②(`google.script.run`)로 같은 스크립트의 함수를 직접 부른다(CORS/리다이렉트가 없다). GitHub Pages 처럼 화면을 따로 호스팅하는 방식에서는 같은 `api.js` 가 `fetch(API_URL)` 로 `doGet`/`doPost` 를 부른다([§8.2](#82-apijs)).

### 역할 분담

| 영역 | 역할 |
|---|---|
| **프런트엔드** | 게임의 모든 로직(물리, 합치기, 점수, 게임오버). 서버 없이도 단독 플레이 가능해야 한다 |
| **Google Apps Script** | 게임 화면 제공(`Index.html`)과 랭킹 저장/조회. 게임 로직은 서버에 두지 않는다 |
| **Google Sheets** | 점수 데이터 저장소 (DB 대용) |
| **빌드 (`scripts/build-gas.mjs`)** | 개발용 소스(ES Modules + CDN)를 Apps Script 가 서빙할 한 파일로 묶는다. 런타임에는 관여하지 않는다 |

### 호스팅 방식 선택

| | A. GAS `HtmlService` 로 화면까지 서빙 **(기본, 현재 배포 방식)** | B. GitHub Pages + GAS API (선택) |
|---|---|---|
| 장점 | 배포 대상이 하나(웹 앱 주소 하나), CORS/리다이렉트 문제가 없음(`google.script.run`), 화면 호스팅이 따로 필요 없음, 같은 서버 규칙을 거침 | Git 중심 개발, 로딩 빠름, 로컬 개발 쉬움, 외부 클라이언트와 같은 JSON API |
| 단점 | iframe 샌드박스 제약(`location.search` 에 방문자의 쿼리가 안 실림, 저장소가 막힐 수 있음), 로딩이 느림, 화면을 한 파일(`gas/Index.html`)로 묶는 빌드가 필요, 다른 사이트 iframe 삽입 미보장([§7.4](#74-배포-절차)) | 배포 대상이 둘(페이지 + GAS), CORS preflight 제약([§8.1](#81-cors-규칙-fetch-통로-가장-흔한-함정)) |

**소유자는 A 로 배포합니다.** 개발은 계속 정적 파일 + ES Modules(`index.html`, `js/`, `css/`)로 하고, 배포용 `gas/Index.html` 은 `npm run build:gas` 가 만든 생성물(직접 고치지 않음)입니다. 코드는 두 방식을 모두 지원합니다: `js/api.js` 는 호출할 때마다 `window.google.script.run` 이 있으면 그것을, 없으면 `API_URL` 의 `fetch` 를 씁니다([§8.2](#82-apijs)). B 방식(GitHub Pages)도 그대로 동작합니다.

---

## 3. 프로젝트 구조

**개발은 빌드 도구 없이 정적 파일 + ES Modules**로 합니다(번들러 없이 `npm run serve` 만으로 돌아가므로 진입 장벽이 낮고 GitHub Pages 에도 그대로 올라갑니다). **배포용 한 파일(`gas/Index.html`)만 빌드로 만듭니다** — Apps Script 의 HtmlService 는 폴더나 ES Module 을 서빙하지 않고 HTML 파일 하나씩만 다루기 때문입니다.

```
seongmo--fruit/
├─ index.html              # 개발용 진입점: 캔버스, HUD, 모달 마크업 (DOM id/class 가 모듈 사이의 계약)
├─ css/
│  └─ style.css
├─ js/
│  ├─ config.js            # 상수: 과일 정의, 월드 크기, 점수 규칙, 타이밍, API_URL, 저장 키
│  ├─ main.js              # 부트스트랩, 게임 루프, 모듈 연결, ?debug 훅
│  ├─ physics.js           # Matter.js 월드/벽/과일 생성, 충돌 → 합치기 큐
│  ├─ game.js              # 점수, 다음 과일, 상태 머신, 게임오버 판정 (렌더/DOM/Matter 비의존)
│  ├─ render.js            # Canvas 그리기 (과일, 경계선, 이펙트)
│  ├─ input.js             # 포인터/키보드 입력
│  ├─ audio.js             # 효과음 (Web Audio 합성, 파일 없음)
│  ├─ storage.js           # localStorage 래퍼 (try/catch + 메모리 대체)
│  └─ api.js               # 서버 통신 (google.script.run 또는 fetch: 랭킹 조회/점수 제출)
├─ gas/                    # Apps Script 프로젝트에 올릴 파일 딱 세 개. clasp 는 이 폴더를 통째로 올리므로 다른 파일을 두지 않는다
│  ├─ Code.gs              # 백엔드 + 화면 제공 (서버 규칙의 단일 출처)
│  ├─ Index.html           # 생성물: 게임 전체를 한 파일로 묶음. 직접 고치지 않는다 (npm run build:gas). 커밋한다
│  └─ appsscript.json      # 매니페스트: V8, 시간대 Asia/Seoul, 웹 앱 USER_DEPLOYING / ANYONE_ANONYMOUS
├─ scripts/
│  └─ build-gas.mjs        # gas/Index.html 빌더 (esbuild). 라이브러리로도 import 된다 (테스트)
├─ tests/
│  ├─ *.test.mjs           # 단위/통합 테스트 (node --test, 브라우저 불필요). build.test.mjs 가 gas/Index.html 을 검사
│  ├─ helpers/gas-env.mjs  # Code.gs 를 vm 에서 돌리는 모의 Apps Script 서비스 + 모의 google.script.run
│  └─ e2e/                 # 헤드리스 Chromium e2e
│     ├─ smoke.mjs         #   개발용 페이지
│     ├─ gas.mjs           #   Apps Script 배포 모의 (진짜 Code.gs + 진짜 gas/Index.html)
│     └─ harness.mjs       #   두 묶음의 공용 도우미
├─ docs/
│  └─ DEVELOPMENT_GUIDE.md
├─ README.md               # Apps Script 배포 절차(첫 화면), 실행/테스트/Pages 요약 (이 가이드의 짧은 입구)
├─ package.json            # 개발 의존성(esbuild, matter-js, playwright-core)과 npm 스크립트. 배포물에는 쓰이지 않는다
├─ package-lock.json
├─ .gitattributes          # gas/ 의 세 파일을 LF 로 고정 (최신성 검사가 바이트 단위 비교라서)
├─ .nvmrc                  # 개발용 Node 버전
└─ .gitignore              # node_modules/, .clasp.json 등
```

> 과일 스프라이트/효과음 파일용 `assets/` 폴더는 아직 없습니다. 지금은 이모지와 Web Audio 합성을 쓰며, 스프라이트로 바꿀 때 `FRUITS[i].sprite`에 URL 을 넣고 폴더를 만듭니다. 다만 Apps Script 단일 배포에서는 `./assets/...` 같은 상대 경로 파일을 서빙할 곳이 없습니다(HtmlService 는 HTML 파일 하나씩만 내보낸다). 스프라이트를 쓰려면 이미지를 data URI 로 만들어 넣거나 이미지만 따로 호스팅해야 하고, 빌드는 이를 자동으로 처리하지 않습니다(`index.html`/CSS 의 상대 경로 자원은 빌드가 거부하지만 `config.js` 의 `sprite` 문자열은 검사하지 않는다).

**모듈 의존 원칙**

- `game.js`는 DOM/Canvas를 모른다 → 단위 테스트와 규칙 변경이 쉬워진다.
- `config.js`의 수치만 바꿔서 밸런스를 조정할 수 있어야 한다.
- 네트워크 호출은 `api.js`에만 둔다. 실패해도 게임은 계속 돌아가야 한다.
- 화면 코드는 서버를 `api.js` 의 함수로만 부른다. `google.script.run` 을 직접 쓰는 곳은 `api.js` 하나다.

---

## 4. 개발 환경

### 로컬 실행

개발용 화면은 ES Module 이라 `file://`로 열면 동작하지 않으므로 로컬 서버가 필요합니다.

```bash
# 프로젝트 루트에서
npm run serve                  # = python3 -m http.server 8000
# → http://localhost:8000
```

모바일 실기기 테스트는 같은 Wi-Fi에서 `http://<PC의 IP>:8000`으로 접속합니다. 설치할 것은 없지만(Python 3 만 필요), 개발용 화면은 Matter.js 를 CDN 에서 불러오므로 인터넷 연결은 필요합니다. Apps Script 에 올라가는 `gas/Index.html` 에는 Matter.js 가 통째로 들어 있어 네트워크가 필요 없습니다.

### 의존 라이브러리

| 라이브러리 | 용도 | 비고 |
|---|---|---|
| [Matter.js](https://brm.io/matter-js/) | 2D 물리 엔진 (원형 충돌, 중력, 쌓임) | 개발용 `index.html` 은 CDN 으로 로드, **버전 고정**(`0.19.0`). 배포 빌드는 `node_modules/matter-js`(같은 버전, devDependency)를 인라인한다 |
| [esbuild](https://esbuild.github.io/) | `gas/Index.html` 빌드 때 `js/` 모듈을 한 스크립트로 묶는다 | devDependency, 버전 고정. 런타임에는 쓰이지 않는다 |

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.19.0/matter.min.js"></script>
```

> 물리 엔진을 직접 만들지 않는 이유: 원이 쌓이고 굴러서 안정되는 동작(접촉 해소, 슬립)을 직접 구현하면 비용이 크고 불안정합니다. Matter.js는 이 용도에 충분합니다.
> `index.html` 의 CDN 주소 속 버전과 `matter-js` devDependency 버전이 다르면 빌드가 실패합니다(어긋난 버전이 몰래 들어가지 않게).

### 테스트 실행

개발 의존성(`esbuild`, `matter-js`, `playwright-core`)은 빌드와 테스트에만 쓰이며 배포물에는 들어가지 않습니다(배포물은 `gas/` 의 세 파일). 필요한 Node 는 **20 이상**(`.nvmrc` 는 22)입니다.

```bash
npm ci                 # 의존성 설치 (Node 20+)
npm test               # 단위/통합 테스트 (node --test). 브라우저 불필요. gas/Index.html 최신성 검사 포함
npm run e2e:install    # e2e 용 Chromium 을 한 번 내려받는다 (playwright-core 는 브라우저를 포함하지 않는다)
npm run test:e2e       # 헤드리스 Chromium e2e 두 묶음을 차례로: smoke(개발용 페이지) + gas(Apps Script 배포 모의)
npm run test:e2e:smoke # smoke 만
npm run test:e2e:gas   # Apps Script 배포 모의(gas/Index.html 을 sandbox iframe 안에서)만
```

- 이미 설치된 Chromium 을 쓰려면 `CHROMIUM_PATH=/경로/chrome npm run test:e2e`, 일부 시나리오만 돌리려면 `npm run test:e2e:smoke -- --only=a,c` (또는 `test:e2e:gas`), 창을 보려면 `-- --headed`. smoke 의 시나리오 id 는 `a b b2 c d e e2 f g g2 h h2~h5 i1~i3 j k k2 l m n1~n4` 이고, 각 id 의 제목은 `tests/e2e/smoke.mjs` 에 있다.
- **gas e2e (`tests/e2e/gas.mjs`)**: 진짜 `gas/Code.gs` + 진짜 `gas/Index.html` 을 Apps Script 처럼 서빙한다. 웹 앱 주소로 GET 이 오면 진짜 `doGet()` 이 불리고, 돌려받은 `HtmlOutput` 의 title/viewport meta 로 바깥 래퍼 페이지를 만들고 그 안의 sandbox iframe(서로 다른 origin, `allow-same-origin` 이 있는 것과 없는 것 둘 다)에 화면을 넣는다. iframe 안의 `google.script.run` 은 `window.google.script.run` 흉내(호출마다 새 실행기, 비동기, JSON 값만)로 Node 의 진짜 `apiRanking/apiSubmit` 에 연결되고, 시나리오마다 지연/실패/응답 유실/먹통/이상한 결과를 주입한다. 하네스 서버 밖으로 나가는 요청, 콘솔 오류/경고, `pageerror` 는 실패다. 시나리오 id 는 `load layout-390 layout-1280 play ranking ranking-empty submit throttle idempotent failure server-errors concurrent boot-pending timeout offline offline-pending late-google fetch-only google-wins no-debug storage-blocked exec-routing` 이고 (대부분 `@same`/`@opaque` 두 번), `--only=submit` 처럼 고른다. `--bail` 은 첫 실패에서 멈추고, `--shots=폴더` 는 iframe 안 화면 스크린샷만 저장한다.
- **이 하네스는 진짜 Apps Script 가 아니라 그 동작의 모형이다.** 바깥 래퍼 페이지의 정확한 모양, sandbox 속성 조합, `google.script.run` 의 오류/직렬화 세부, HtmlService 의 세부 동작은 공식 문서로 확인하지 못한 가정이다(모의 헬퍼 `tests/helpers/gas-env.mjs` 머리말에도 같은 단서가 있다). 그래서 이 e2e 가 통과해도 실제 배포에서의 확인([§9](#9-개발-로드맵마일스톤) 남은 일)은 대신하지 못한다.
- gas e2e 는 **`gas/Index.html` 을 읽으므로** `js/`, `css/`, `index.html` 을 고친 뒤에는 `npm run build:gas` 가 먼저다 (`npm test` 의 최신성 검사가 그렇게 알려 준다).
- smoke e2e 는 **`js/config.js` 의 `API_URL` 과 무관하게** 동작합니다. 하네스가 모든 시나리오에서 이 값을 `''`(오프라인) 또는 가짜 URL 로 바꿔 서빙하므로, 운영 URL 을 넣은 뒤에도 외부로 요청이 나가지 않습니다.
- Matter.js 는 CDN 대신 `node_modules` 의 같은 버전으로 대체되어 네트워크가 필요 없습니다.
- 물리 테스트(`tests/physics.test.mjs`, `tests/integration.test.mjs`)는 `matter-js` 가 없으면 건너뜁니다. `CI` 환경변수가 설정돼 있으면 건너뛰지 않고 실패합니다.

### Apps Script 배포용 빌드 (`npm run build:gas`)

```bash
npm run build:gas      # gas/Index.html 을 (다시) 만든다
npm run check:gas      # 쓰지 않고 커밋된 파일이 최신인지만 확인한다 (다르면 종료 코드 1)
```

`scripts/build-gas.mjs` 가 하는 일:

1. `js/main.js` 와 그것이 import 하는 모든 모듈을 esbuild 로 **하나의 클래식(비모듈) IIFE 스크립트**로 묶는다. 대상은 es2020, **압축하지 않아** 소유자가 읽을 수 있고, 한글/이모지는 `\u` 이스케이프 없이 그대로 두며, 맨 앞에 `"use strict"` 를 붙여 ES Module 시절의 strict 모드 의미를 유지한다. esbuild 경고도 실패로 취급한다.
2. `index.html` 에서 표식 세 개를 **정확히 한 번씩** 찾아 바꾼다: ① `<link rel="stylesheet" href="./css/style.css">` → `css/style.css` 를 인라인 `<style>` 로, ② Matter.js CDN `<script src=…>` → `node_modules/matter-js/build/matter.min.js` 를 인라인 `<script>` 로(소스맵 참조 줄은 제거), ③ `<script type="module" src="./js/main.js">` → 1번의 번들을 인라인 클래식 `<script>` 로(`<body>` 끝, Matter 뒤라서 전역 `Matter` 가 먼저 생긴다).
3. `<!doctype html>` 바로 아래에 "GENERATED FILE. DO NOT EDIT." 와 생성 명령(`npm run build:gas`)을 알리는 HTML 주석을 붙인다 (문서가 주석이 아니라 doctype 으로 시작하도록).

**시끄럽게 실패한다**(아무것도 쓰지 않고 종료 코드 1, 이유를 출력): 표식이 없거나 두 번 이상 있음, doctype/`<head>`/`<body>` 구조 이상, Matter 버전 불일치, 인라인으로 들어갈 코드 안에 HTML 파서를 속일 수 있는 문자열(`</script`, `</style`, `<!--`, `-->`, `<?`, U+2028/2029, NUL)이 있음 — 몰래 이스케이프하지 않고 거부해서 원인을 사람이 보게 한다, CSS 에 `@import` 나 `data:` 가 아닌 `url()` 이 있음, 조립 결과에 `data:` 가 아닌 `src`/`href` 가 남음. `<?` 를 막는 이유: `createHtmlOutputFromFile` 은 스크립틀릿을 평가하지 않지만(템플릿이 아님), 누가 템플릿으로 바꿔도 안전하게 하려는 것이다.

**결정적**이다: 같은 입력이면 바이트까지 같은 출력(LF, BOM 없음, 끝 개행 하나). 그래서 **커밋된 `gas/Index.html` 은 항상 빌드 결과와 같아야** 하고, `tests/build.test.mjs` 가 이를 강제한다. 원본(`index.html`, `css/`, `js/`)을 고치고 빌드를 잊으면 `npm test` 가 "gas/Index.html 이 오래됐습니다" 로 실패한다. `js/config.js` 의 `API_URL` 도 번들에 들어가므로 바꾸면 다시 빌드해야 한다. 현재 크기는 약 175KB 이다.

같은 테스트 파일이 구조도 확인한다: 인라인 `<style>` 1개, 인라인 `<script>` 2개(Matter, 앱: 모두 속성 없는 클래식 스크립트로 구문 분석됨, Matter 가 앱보다 먼저), 외부 자원 없음(`src`/`href` 는 favicon 의 `data:` 하나뿐, `http(s)://` 문자열은 Matter 머리말 주석과 favicon 의 SVG 네임스페이스뿐), `gas/` 에 세 파일만 있음, 크기 상한(우리 쪽 안전선 384 KiB. Apps Script 의 공식 한도로 확인한 값이 아니다), 빌더의 음성 테스트(표식 변조, 위험 문자열, 외부 자원 주입).

### GAS 개발 (선택: clasp)

Apps Script 편집기에서 직접 붙여 넣어도 되지만([README](../README.md) 의 절차), 터미널에서 올리려면 [clasp](https://github.com/google/clasp)를 사용합니다. 아래는 일반적인 clasp 사용법이며 이 프로젝트에서 실행해 보지는 않았습니다.

```bash
npm run build:gas                       # 먼저 gas/Index.html 을 최신으로
npm i -g @google/clasp
clasp login
# 저장소 맨 위에 .clasp.json (.gitignore 대상) 을 만든다: { "scriptId": "<SCRIPT_ID>", "rootDir": "gas" }
clasp push                              # 로컬 gas/ 의 세 파일 → Apps Script (저장된 코드)
```

- `clasp clone` 은 반대 방향(Apps Script → 로컬)이라 `gas/` 의 파일을 덮어쓸 수 있으므로 쓰지 않는다.
- `clasp push` 는 저장된 코드(HEAD)만 바꾼다. 웹 앱 `/exec` 는 **배포된 버전**을 실행하므로 편집기의 **배포 → 배포 관리 → 편집 → 새 버전 → 배포**(또는 clasp 의 deploy 명령)가 따로 필요하다.
- `gas/` 안의 모든 파일이 올라가므로 세 파일 외에는 두지 않는다(`tests/build.test.mjs` 가 지킨다).

---

## 5. 게임 설계 상세

### 5.1 월드와 좌표

- **논리 좌표계는 고정**(`400 × 600`)하고, 화면 크기에 맞춰 캔버스를 **스케일**한다. 물리는 항상 논리 좌표에서 계산하므로 기기마다 게임 난이도가 달라지지 않는다.
- 플레이 영역은 `x ∈ [0, 400]`, `y ∈ [0, 600]`. 상자는 바닥 + 좌/우 벽(정적 바디)이며 **벽은 이 영역 바깥**(`x < 0`, `x > 400`, `y > 600`)에 놓인다. 위쪽은 열려 있다. 따라서 과일 중심이 움직일 수 있는 범위는 `[r, 400 - r]` 이다.
- 캔버스는 이 영역만 보여 주며 CSS 비율은 `2:3` 이다.
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
| `IDLE` | 시작 화면. 아직 판이 시작되지 않음 |
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

- **드롭 유예(`TIMING.settleGrace` = 1500ms)**: 드롭/생성(합쳐져 태어난 것 포함) 직후의 과일은 판정에서 제외.
- **체류 시간(`TIMING.overflow` = 2000ms)**: 과일의 윗면(`y - radius`)이 경계선(`WORLD.dangerY`)보다 위인 상태가 **연속으로** 이 시간 이상 유지되면 게임오버. 중간에 내려가면 타이머 리셋.

**시간 기준**: 쿨다운, 드롭 유예, 경계선 체류, 플레이 시간은 모두 **시뮬레이션 시간**(물리 스텝 수 × `1000/60` ms)으로 잰다. 탭을 백그라운드로 보내거나 프레임이 멈춰도 규칙이 어긋나지 않고, 테스트가 결정적으로 시간을 진행할 수 있다. 실제 시계(`performance.now`)는 렌더러의 이펙트/깜빡임에만 쓴다.

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

### 6.1 설정 (`config.js`)

과일 정의(`FRUITS`: 이름·반지름·이모지·색, 선택적 `sprite`)와 아래 수치는 모두 `js/config.js` 한 곳에 있고, 밸런스는 이 파일의 숫자만 바꿔서 조정한다. 이 파일은 DOM/Matter 에 의존하지 않아 Node 에서도 import 된다.

```js
// 플레이 영역은 x∈[0,width], y∈[0,height]. 벽(두께 wall)은 이 영역 '바깥'에 놓인다.
export const WORLD = { width: 400, height: 600, wall: 20, dangerY: 100, spawnY: 50 };

export const LAST_LEVEL = FRUITS.length - 1;        // 10 (수박)
export const MAX_DROP_LEVEL = 4;                    // 떨어뜨릴 수 있는 최대 단계
export const DROP_WEIGHTS = [30, 28, 20, 14, 8];    // 단계별 출현 가중치 (길이 = MAX_DROP_LEVEL + 1)
export const scoreOf = (level) => ((level + 1) * (level + 2)) / 2;
export const WATERMELON_PAIR_BONUS = 100;

export const TIMING = { step: 1000 / 60, dropCooldown: 500, settleGrace: 1500, overflow: 2000 };
export const PHYSICS = { gravityY: 1, restitution: 0.1, friction: 0.1, frictionStatic: 0.5 };

export const API_URL = '';           // Apps Script 웹 앱 URL(…/exec). 화면을 따로 호스팅(GitHub Pages)할 때만 필요. Apps Script 안에서는 google.script.run 이 우선이라 쓰이지 않는다
export const NICKNAME_MAX = 12;
export const RANKING_LIMIT = 10;
export const STORAGE_KEYS = {        // localStorage 키
  best: 'fruit.best', nickname: 'fruit.nickname', muted: 'fruit.muted',
  pending: 'fruit.pendingScore', clientId: 'fruit.clientId',
};
```

> **이모지 → 스프라이트 전환**: 이모지는 OS마다 모양이 다르고 크기 제어가 어렵습니다. 프로토타입은 이모지로 빠르게 만들고, 렌더러가 `FRUITS[i].sprite`가 있으면 이미지를, 없으면 이모지를 그리도록 만들어 두었으므로 나중에 `config.js`만 수정해 교체할 수 있습니다.

### 6.2 물리 월드 (`physics.js`)

Matter.js(전역 `Matter`: 개발용 페이지는 CDN 스크립트, 배포 빌드는 같은 버전의 인라인 사본)를 감싼 모듈이다. 인터페이스:

```js
const physics = createPhysics({ onMerge });     // onMerge({ level, x, y, bonus }) — 합치기 1번당 1회
physics.step(dtMs, simTime);   // Engine.update → 속도 제한 → 벽 이탈 보정 → 합치기 큐 처리
physics.spawn(level, x, y, simTime, { merged, velocity });   // 과일 바디 생성 (bornAt/mergedAt 기록)
physics.bodies();              // 살아 있는 과일 바디들
physics.clear();               // 모든 과일과 대기 중인 합치기 제거 (재시작)
```

- 벽은 플레이 영역 **바깥**에 두꺼운 정적 바디(바닥/좌/우, 두께 `max(WORLD.wall, 100)`)로 세우고 위쪽은 열어 둔다(천장 없음). 얇으면 빠른 과일이 터널링으로 뚫고, 튕겨 오른 과일이 넘어가지 못하도록 좌/우 벽은 위로 아주 높게(`y = -2000` 까지) 세운다.
- 큰 과일이 작은 과일 위에 쌓일 때의 떨림을 줄이려고 Matter 의 반복 횟수를 기본값보다 올렸고(위치 10 / 속도 8), 원은 32각형으로 근사한다.
- 과일 바디에는 `isFruit`, `level`, `merging`, `bornAt`, `mergedAt`, `overSince` 가 붙는다. 시간 값은 모두 시뮬레이션 시간이다.
- `onMerge` 의 `level` 은 **새로 생긴** 과일의 단계다. 수박끼리의 합치기는 `level = LAST_LEVEL`, `bonus = true` 이며 둘 다 제거하고 새 과일은 만들지 않는다.

**주의할 점**

- 충돌 콜백(`collisionStart`/`collisionActive`) 안에서는 월드를 건드리지 않고 `merging = true` 표시와 큐 적재만 한다. 실제 제거/생성은 `step()` 안에서 `Engine.update` 뒤에 일괄 처리한다.
- `collisionActive`도 구독한다. 합쳐진 과일이 이웃과 겹쳐서 태어났을 때 `collisionStart` 가 다시 오지 않기 때문이다.
- 새로 생긴 큰 과일이 이웃을 밀어내며 연쇄 합치기가 일어나는 것은 **정상 동작**이다(콤보). 막지 않는다.
- 드롭 전 대기 중인 과일은 물리 바디가 아니라 **렌더링용 객체**로만 둔다. 드롭하는 순간 `spawn` 으로 바디를 만든다.
- 합쳐진 새 과일은 두 과일의 **중간 지점**에서 **속도의 평균**을 이어받는다(`velocity` 옵션).
- 안전망 두 가지: 속도 상한(`MAX_SPEED = 40`)으로 터널링을 막고, 벽/바닥에 중심이 반지름의 절반보다 깊이 파고든 과일은 끌어낸다. 큰 과일이 합쳐져 태어날 때 이웃한 작은 과일이 벽 쪽으로 눌리는 일이 실제로 있어 둔 장치다.
- `onMerge` 콜백이 예외를 던져도 나머지 합치기는 끝까지 처리하고(그렇지 않으면 `merging = true` 로 고착), 첫 예외를 마지막에 다시 던진다.

### 6.3 게임 루프 (`main.js`)

렌더링과 물리를 분리하고, 물리는 **고정 타임스텝**으로 돌려 주사율(60/120/144Hz)과 무관하게 결과가 같도록 한다.

```js
function frame(app, now) {
  requestAnimationFrame((t) => frame(app, t));
  const dt = app.last === null ? 0 : clamp(now - app.last, 0, 100);   // 탭 전환 후 복귀 시 폭주 방지
  app.last = now;
  if (!app.paused) advanceSimulation(app, dt);    // acc += dt; while (acc >= step) stepOnce(app). paused 는 ?debug 훅용
  app.input.update(dt);                           // 방향키를 누르고 있는 동안 조준 이동
  app.renderer.draw(buildFrame(app, now));
}

function stepOnce(app) {
  app.steps += 1;
  app.simTime = app.steps * TIMING.step;          // 부동소수점 누적 오차 없이 스텝 수로 계산
  app.physics.step(TIMING.step, app.simTime);     // 합치기 → onMerge → 점수/이펙트/효과음
  app.game.update(app.simTime);                   // 쿨다운 종료
  if (checkOverflow(app)) handleGameOver(app);
}
```

### 6.4 게임 규칙과 게임오버 판정 (`game.js`)

`game.js` 는 DOM/Matter 를 모르는 순수 로직이라 Node 에서 단위 테스트한다. 점수, 최고 단계, 드롭 수, 수박 완성 여부(`cleared`, 첫 수박에서 한 번), 현재/다음 과일(가중치 추첨, `rng` 주입 가능), 상태 머신(`IDLE` → `READY` ⇄ `COOLDOWN` → `GAME_OVER`), 플레이 시간을 가진다.

게임오버 판정은 `evaluateOverflow(items, simTime)` 가 한다. 각 항목은 `{ y, radius, bornAt, overSince }`:

- `simTime - bornAt < TIMING.settleGrace` 인 과일은 판정에서 제외하고 `overSince` 를 비운다.
- 과일의 윗면(`y - radius`)이 `dangerY` 보다 위면 `overSince` 를 기록하고(없을 때만), `(simTime - overSince) / TIMING.overflow` 를 위험도로 본다. 내려가면 `overSince` 를 비워 타이머를 리셋한다.
- 가장 높은 위험도가 `danger ∈ [0, 1]`, 1 에 닿으면 게임오버. `danger` 는 렌더러가 경고 표시에 쓴다.

경계선을 넘기 직전(체류 시간의 50% 이상, `danger >= 0.5`)에는 경계선을 **붉게 깜빡여** 플레이어에게 경고한다. 사용자가 OS 의 **모션 줄이기**를 켰다면 깜빡이지 않고 같은 붉은 강조를 고정해서 보여 준다([§6.6](#66-렌더링-renderjs)).

### 6.5 입력 (`input.js`)

- **Pointer Events**(`pointerdown/move/up`) 하나로 마우스와 터치를 함께 처리한다.
- 캔버스에 CSS `touch-action: none;` — 안 쓰면 모바일에서 스크롤/확대가 끼어든다. (`<meta viewport>` 에 `user-scalable=no` 를 넣어 확대를 막지는 않는다. 저시력 사용자의 확대를 막으면 접근성(WCAG 1.4.4) 위반이다.)
- 포인터 x는 **캔버스 좌표 → 논리 좌표**로 변환한 뒤, 현재 과일이 벽을 뚫지 않도록 `[r, W - r]`로 clamp한다. 벽이 플레이 영역 바깥에 있으므로 `wall` 은 빼지 않는다.
- 모바일은 `pointermove`로 위치를 잡고 **`pointerup`에서 드롭**하는 방식이 손가락에 과일이 가려지는 문제를 줄여준다. 마우스/펜은 누르지 않고 움직이기만 해도 조준하고(클릭하면 드롭), 터치는 누르고 있는 동안만 조준한다. 누르는 사이에 오버레이가 뜨면 드롭하지 않는다.
- 데스크톱 보조: `← →` 이동, `Space` 드롭. 키를 **누르고 있어서 생기는 자동 반복(`repeat`)은 무시**한다. 닉네임 입력칸이나 버튼에 포커스가 있을 때는 키를 가로채지 않는다.

### 6.6 렌더링 (`render.js`)

- `devicePixelRatio`를 반영해 캔버스 내부 해상도를 키우고, CSS 크기로 줄여 보여준다 (레티나에서 흐려지지 않게).
- 그리는 순서: 배경 → 상자/경계선 → 과일 → 대기 중인 과일 + 낙하 가이드선 → 이펙트. (HUD 는 DOM)
- 합치기 이펙트: 새 과일을 `scale 0.8 → 1.12 → 1.0`으로 **180ms** 튀게(렌더 전용 스케일, 물리 반지름은 즉시 확정) + 파티클/링/점수 글자.
- **모션 줄이기(`prefers-reduced-motion: reduce`)**: CSS 애니메이션/전환은 `style.css` 에서, 캔버스는 렌더러가 `matchMedia` 로 직접 반영한다(실행 중 설정을 바꿔도 따라간다). 경계선 경고는 점멸 없이 고정, 과일 튀기/파티클/링/드롭 이펙트는 생략, 점수 글자는 제자리에서 잠깐 보인다. 과일의 물리 움직임은 게임 자체라서 그대로다.
- Next 과일, 현재 점수, 최고 점수는 DOM(HUD)에 표시한다. DOM 이라 접근성/반응형이 쉽다.
- 렌더러는 규칙/물리를 모르고 `main.js` 가 넘겨 주는 `frame`(`bodies`, `held`, `danger`, `state`, …)만 그린다. 모듈 로드 시점에 DOM 에 접근하지 않아 Node 에서 import 하고 가짜 2D 컨텍스트로 테스트할 수 있다.

### 6.7 반응형/모바일/접근성

- 레이아웃은 **세로 모바일 우선**. 게임 영역 비율 `2:3`을 유지하며 화면에 맞춰 축소.
- **낮은 가로 화면**(가로로 눕힌 폰, 200~300% 확대한 데스크톱: `@media (orientation: landscape) and (max-height: 500px)`)에서는 게임판을 왼쪽에 높이만큼 크게 두고 HUD/진화 줄을 오른쪽에 세운다. 이 모드에서 시작/결과/랭킹 패널은 게임판 안이 아니라 **화면 전체 기준**으로 펼쳐진다. 패널이 스크롤돼도 '게임 시작'/'다시 하기'/'닫기' 버튼은 아래에 고정되어 보인다.
- 닉네임 입력 줄은 뷰포트 폭이 아니라 **패널의 실제 폭**으로 줄바꿈한다(입력칸 최소 `9em`).
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`. **Apps Script 에서는 HTML 파일에 직접 쓴 meta 가 무시되고**(공식 문서) 화면이 바깥 페이지 안의 iframe 에 들어가므로, 서버가 같은 값을 `addMetaTag('viewport', …)` 로 넣는다(`Code.gs` 의 `PAGE_VIEWPORT`. `tests/gas.test.mjs` 가 `index.html` 의 값과 같은지 확인한다). 페이지 제목도 서버의 `setTitle('수박 합치기')` 가 정한다.
- iOS Safari는 사용자 제스처 전까지 오디오가 막힌다 → **첫 터치에서 AudioContext를 resume**.
- 더블탭 확대, 길게 눌러 선택/컨텍스트 메뉴가 뜨지 않게 `user-select: none`, `touch-action` 등을 적용.
- 색 대비는 WCAG AA(일반 글자 4.5:1)를 기준으로 한다. 기본 버튼은 흰 글자 대비 4.9~5.6:1, 보조 글자색은 카드/HUD 위에서 4.5:1 이상이다(`tests/static.test.mjs` 가 CSS 에서 읽어 검증한다).
- 토글 버튼(음소거)은 이름(`aria-label="음소거"`)을 고정하고 상태는 `aria-pressed` 로만 알린다. 이름이 상태에 따라 바뀌면 "소리 켜기, 눌림" 같은 모순된 낭독이 된다.

### 6.8 저장 (`storage.js`)

최고 점수와 닉네임, 음소거 설정, 전송 실패한 점수(`pending`), 익명 `clientId` 는 `localStorage`에 저장한다. 사생활 보호 모드 등에서 접근이 **예외를 던질 수 있으므로** 모든 읽기/쓰기를 `try/catch`로 감싸고(메모리 대체값 포함), 실패해도 게임은 정상 동작해야 한다. `clientId` 는 `/^[A-Za-z0-9_-]{16,64}$/` 형식의 무작위 값으로 한 번 만들어 저장한다.

Apps Script 의 화면은 Google 이 만든 sandbox iframe 안에서 열려 브라우저에 따라 `localStorage` 가 막히거나 분리될 수 있다(미확인: 실제 동작은 브라우저마다 다를 수 있다). 막히면 이 래퍼의 메모리 대체값으로 이번 접속 동안만 기억하고, 새로고침하면 최고점/닉네임/`clientId` 를 잃는다(서버의 랭킹에는 영향이 없고, 다음 접속에서의 자동 재전송은 못 한다). gas e2e 의 `storage-blocked` 시나리오가 `allow-same-origin` 이 없는 iframe 으로 이 경로를 확인한다.

### 6.9 디버그 훅 (`?debug`)

주소에 **`debug` 파라미터**(`?debug`, `?debug=1`)가 있을 때만 `window.__fruit` 가 생긴다. 이름에 `debug` 가 들어 있을 뿐인 쿼리(`?nodebug=1`)에는 생기지 않는다. e2e 가 시뮬레이션을 결정적으로 제어하는 데 쓴다.

| 멤버 | 설명 |
|---|---|
| `game`, `physics` | 실행 중인 객체 |
| `spawn(level, x, y)` / `bodies()` | 과일 생성 / 현재 과일 요약 |
| `pause()` / `resume()` | 실시간 루프 정지/재개 |
| `advance(ms)` | 정지 중에도 `ms` 만큼 시뮬레이션을 결정적으로 진행 |
| `forceGameOver()` | 판을 즉시 끝낸다 (시작 전이면 먼저 시작) |
| `getState()` / `getScore()` | 상태 / 점수 |

`?debug` 가 없으면 훅은 만들어지지 않는다(개발용 주소에서는 누구든 `?debug` 를 붙이면 쓸 수 있다). 점수는 어차피 클라이언트를 신뢰할 수 없으므로 이 훅이 보안 경계를 바꾸지는 않는다([§12](#12-보안과-주의사항)).

**Apps Script 로 배포한 화면에서는 훅이 생기지 않는다.** 화면이 sandbox iframe 안에서 열려 `location.search` 에 방문자의 쿼리가 실리지 않는다고 보고 있기 때문이다(공식 문서는 iframe 안에서 주소의 파라미터를 읽으려면 `google.script.url` API 를 쓰라고 안내하며, `location.search` 가 비어 있다는 것 자체는 직접 확인하지 못했다). 이 코드는 `location.search` 만 읽고 `google.script.url` 은 쓰지 않으므로, 그 가정이 맞으면 운영 화면에서는 훅이 켜지지 않는다. 가정이 틀려 쿼리가 실린다 해도 개발용 주소와 같은 상태일 뿐이라 보안 경계는 바뀌지 않는다. 테스트는 로컬 서버가 iframe 주소에 `?debug` 를 붙여(`tests/e2e/gas.mjs`) 확인하고, `no-debug` 시나리오가 `?debug` 가 없을 때 노출되지 않는 것을 확인한다.

---

## 7. Google Apps Script 백엔드

백엔드(와 화면 제공)의 **단일 출처는 [`gas/Code.gs`](../gas/Code.gs)** 입니다. 이 문서에 코드를 복사해 두지 않습니다. 배포할 때는 반드시 그 파일을 붙여 넣거나 `clasp push` 로 올리세요. 화면 쪽 `gas/Index.html` 은 소스가 아니라 빌드 생성물이므로 직접 고치지 않습니다([§4](#apps-script-배포용-빌드-npm-run-buildgas)). (예전 가이드에 있던 인라인 코드는 구현과 달라 — 빈도 제한, 닉네임 정제, 점수 상한, 7열 스키마가 없는 — 그대로 배포하면 더 약한 서버가 됩니다.)

### 7.1 시트 구성

스프레드시트를 새로 만들고 시트 이름을 `scores`로 한 뒤 1행에 헤더를 둡니다. **`setup()` 이 이 모든 것을 만들어 주므로 직접 입력할 필요가 없습니다**([§7.4](#74-배포-절차)).

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| `timestamp` | `nickname` | `score` | `maxLevel` | `playTimeMs` | `drops` | `clientId` |

- `clientId` 는 브라우저가 한 번 만들어 저장하는 익명 ID 이며 제출 빈도 제한과 재전송 판별에 쓰입니다.
- **B열(닉네임)은 일반 텍스트 서식**이어야 합니다. 자동 서식이면 시트가 `3-4`, `1/2`, `12:30` 을 날짜/시간으로, `TRUE` 를 불리언으로, `007` 을 숫자 7 로 바꿔 닉네임이 달라집니다. `setup()` 과 첫 제출이 이 서식을 지정합니다(이미 바뀌어 저장된 행은 시트에 보이는 문자열로 대신 보여 주며, 원래 글자는 복구할 수 없습니다).
- 스프레드시트 ID는 **스크립트 속성**의 `SHEET_ID` 에 저장됩니다(`setup()` 이 기록). `NICKNAME_TEXT_FORMAT` 속성은 "이 시트의 닉네임 열 서식을 이미 지정했다"는 표시라서 제출마다 되풀이하지 않게 해 줍니다.

### 7.2 API 명세

**`doGet` 라우팅 규칙**: `e.parameter.action` 이 **없거나 빈 문자열이면 게임 화면**, 비어 있지 않은 문자열이면 JSON API(`ranking` 이면 랭킹, 그 밖의 값은 `bad_request`)다. 두 길은 섞이지 않는다. JSON 요청은 화면 파일을 읽지 않고, 화면 요청은 시트/캐시/락을 건드리지 않는다. `e` 가 `undefined` 여도(`google.script.run` 으로 불려도) 던지지 않고 화면을 돌려준다.

| 메서드 | 요청 | 응답 |
|---|---|---|
| `GET` | (`action` 없음/빈 값) | **게임 화면** (`Index.html`, `HtmlService.createHtmlOutputFromFile('Index')` — 파일 이름은 확장자 없이. 템플릿/스크립틀릿이 아니라 내용 그대로. `setTitle('수박 합치기')`, 서버가 `addMetaTag('viewport', …)` 를 넣는다). `Index` 파일이 없거나 읽을 수 없으면 스택 트레이스 없이 "Index.html 을 추가하세요" 안내(일반 텍스트)를 돌려주고 원인은 실행 로그에만 남긴다 |
| `GET` | `?action=ranking&limit=10` | `{ ok: true, data: [{ nickname, score, maxLevel, at }] }` |
| `GET` | 그 밖의 `action` | `{ ok: false, error: "bad_request" }` |
| `POST` | 본문(JSON 문자열, `text/plain`): `{ nickname, score, maxLevel, playTimeMs, drops, clientId }` | `{ ok: true }` 또는 `{ ok: false, error: "<코드>" }` |

에러 코드: `bad_request`, `invalid_nickname`, `invalid_score`, `implausible`, `throttled`, `server_busy`
(서버 내부 오류는 상세를 숨기고 `server_busy` 로 답하며, 원인은 Apps Script 실행 로그에만 남습니다.)

**게임 화면이 쓰는 통로(`google.script.run`)**: 화면은 같은 스크립트의 공개 함수 `apiRanking(limit)` 와 `apiSubmit(payload)` 를 직접 부른다. 결과는 위 JSON 과 똑같은 `{ ok: true, … }` / `{ ok: false, error }` 객체이고 **절대 throw 하지 않으며**, 검증·빈도 제한·재전송 판별·락·캐시는 `doPost`/`doGet` 과 같은 코드(`submitRaw_`, `rankingResult_`)를 쓴다. 인자와 결과는 JSON 으로 표현되는 값이어야 하고(`Date`, 함수 등은 `google.script.run` 이 거부한다. 공식 문서), 그래서 `apiSubmit` 은 받은 값을 `JSON.stringify` 해서 `doPost` 와 같은 길(`submitRaw_`)로 보낸다.

**노출되는 함수**: `google.script.run` 은 **이름이 `_` 로 끝나지 않는 모든 최상위 함수**를 부를 수 있게 하고(끝나면 비공개, 공식 문서), 화면이 같은 스크립트의 것이므로 방문자(익명 포함)가 개발자 도구로 직접 부를 수도 있다. 그래서 공개 함수는 아래 다섯 개뿐이어야 하고 모두 익명 호출에 안전해야 한다. 새 함수는 `_` 로 끝나게 만든다. `tests/gas.test.mjs` 가 이 목록이 늘면 실패한다.

| 함수 | 용도 | 익명 호출 시 |
|---|---|---|
| `doGet(e)` / `doPost(e)` | 웹 앱 주소로 오는 HTTP 요청 | `e` 가 없어도 던지지 않고 JSON `bad_request` 또는 화면을 돌려준다 |
| `apiRanking(limit)` | 화면의 랭킹 조회 | 이상한 `limit` 은 기본값으로 보정, 던지지 않음 |
| `apiSubmit(payload)` | 화면의 점수 제출 | 서버 검증을 모두 거침, 이상한 입력에도 던지지 않음 |
| `setup()` | 소유자가 편집기에서 한 번 실행 | 멱등이고 데이터를 지우지 않는다. 스프레드시트를 얻지 못하면 예외로 끝나 아무것도 바꾸지 않는다 (웹 앱 실행 안에서 `getActiveSpreadsheet()` 가 무엇을 돌려주는지는 미확인) |

### 7.3 서버 규칙 요약 (`gas/Code.gs`)

수치는 코드의 상수가 기준입니다. 근거와 함께 요약합니다.

| 규칙 | 내용 |
|---|---|
| 점수 상한 | `score <= drops × MAX_SCORE_PER_DROP`(**120**). 드롭당 이론 최댓값 약 111.3점에 약 8% 여유를 둔 값이다(아래 근거). 전체 상한 `MAX_SCORE = 100000` |
| 최소 시간 | `playTimeMs >= (drops - 1) × MIN_MS_PER_DROP`(**400ms**). 첫 드롭은 대기 없이 가능하고 쿨다운은 500ms 라 `drops - 1` 번의 간격만 필요하다. 400 은 프레임 지터 여유(20%)를 둔 값이다 |
| 범위 | `maxLevel 0~10`, `drops 1~5000`, `playTimeMs 1~24h`, 정수만 허용(숫자 또는 숫자 문자열), 본문 2000자 이하 |
| `clientId` | 선택. 있으면 `/^[A-Za-z0-9_-]{16,64}$/` 이어야 하고 아니면 `bad_request`. **없으면 빈도 제한과 재전송 판별을 건너뛴다**(브라우저는 항상 보낸다) |
| 닉네임 | 1~12자(코드포인트 기준). 제어문자·제로폭·RTL 덮어쓰기·**한글 채움 문자(U+115F/1160/3164/FFA0)·점자 빈칸(U+2800)·아랍 문자 표시(U+061C)** 등 눈에 안 보이는 문자를 지운다. 이모지의 변형 선택자/태그 문자는 지키되, 보이는 글자가 하나도 없으면 `invalid_nickname`. `= + - @` 로 시작하면 `'` 를 붙여 수식 인젝션을 막는다 |
| 제출 빈도 | 같은 `clientId` 는 **10초**에 한 번(`throttled`). 확인과 기록을 같은 락 안에서 해 동시 요청도 막는다 |
| **재전송(멱등)** | 같은 `clientId` 가 **같은 판**(점수·최고 단계·플레이 시간·드롭 수가 모두 같음)을 다시 보내면 `{ ok: true }` 로 답하고 행을 늘리지 않는다. 응답이 유실돼(타임아웃/네트워크 끊김) 클라이언트가 재시도해도 같은 기록이 두 줄 쌓이지 않고, "저장됐는데 너무 자주 등록한다" 는 거짓 오류도 나오지 않는다. 최근 500행을 시트에서 직접 보므로 캐시가 만료된 뒤(다음 접속 때 자동 재전송)에도 동작한다. 이때 닉네임을 고쳐 보내도 처음 저장된 닉네임이 남는다 |
| 락 | `LockService` 로 쓰기를 직렬화, 5초 안에 못 잡으면 `server_busy`. 행을 쓴 뒤 **락을 풀기 전에 `SpreadsheetApp.flush()`** 로 쓰기를 확정한다(Lock 공식 문서의 권장). 안 그러면 락을 이어받은 재시도가 방금 쓴 줄을 못 봐 거짓 `throttled` 가 나거나 낡은 랭킹이 캐시에 다시 채워질 수 있다 |
| 랭킹 조회 | 점수 내림차순(같으면 먼저 기록한 쪽이 위), 최대 50행 캐시 60초. 손으로 고쳤거나 깨진 행, 보이는 닉네임이 없는 행은 건너뛴다. 제출 시 캐시를 비운다 |

#### 타당성 임계값의 근거

검사는 두 부등식이다. 정상 플레이를 거부하지 않는 것이 먼저고, 그 안에서 가능한 한 조인다.

- **점수 상한(드롭당 120)**: 과일 Lv L 의 질량을 `2^L`(체리 = 1)로 두면 합치기는 질량을 보존한다. 드롭은 Lv4 이하라 한 번에 최대 `2^4 = 16` 의 질량이 들어온다. Lv L 과일을 *만드는* 합치기는 질량 `2^L` 을 소모하므로 질량 `M` 으로 최대 `M / 2^L` 번 일어나고, 한 번에 `(L+1)(L+2)/2` 점이다. 수박 두 개(질량 2048)가 사라질 때는 보너스 100 이다. 따라서 질량 1단위당 점수의 상한은

  `Σ(L=1..10) (L+1)(L+2)/2 / 2^L + 100/2048 ≈ 6.910 + 0.049 = 6.959`

  이고, 드롭당 `16 × 6.959 ≈ 111.3` 점이다. 여기에 약 8% 여유를 둔 값이 120 이다. 실제 최댓값은 이보다 훨씬 작다. Lv4 로만 채우면(Lv4 는 그 아래 단계의 합치기를 겪지 않으므로) 약 **28.3점/드롭**이다. 상한이 헐거운 것은 점수 규칙이 조금 바뀌어도 정상 기록을 거부하지 않기 위해서다. `tests/gas.test.mjs` 가 `config.js` 의 규칙으로 이 계산을 다시 해서, 상한이 이론값보다 작거나(정상 기록 거부) 10% 넘게 크면(검사가 느슨) 실패한다.
- **최소 시간(드롭 간격 400ms)**: 게임은 **시뮬레이션 시간** 기준 500ms 쿨다운을 강제하고 첫 드롭은 대기 없이 가능하다. 그래서 `n` 번 드롭한 판의 `playTimeMs` 는 항상 `(n - 1) × 500` 이상이다. 서버는 여기에 20% 여유를 둔 `(n - 1) × 400` 을 요구한다. 시간이 시뮬레이션 시간이라 탭을 백그라운드로 보내거나 프레임이 멈춰도 값이 줄어들지 않는다([§5.4](#54-게임오버-판정)).

임계값을 바꿀 때는 `gas/Code.gs` 의 상수와 그 위의 주석, 이 절을 함께 고친다.

### 7.4 배포 절차

비개발자용 단계별 안내(복사/붙여 넣기 중심)는 [`README.md`](../README.md) 에 있다. 여기에는 요점과 이유를 적는다. Google 쪽 동작(배포 메뉴, `/dev` 와 `/exec`, 매니페스트 표시, `google.script.run` 규칙, `addMetaTag`)은 공식 문서의 설명과 맞춰 썼지만, **실제 Apps Script 에 올려 확인한 것은 아니다**([§9](#9-개발-로드맵마일스톤) 남은 일).

**방식 A (기본): 웹 앱 하나로 게임 + 랭킹** — 올릴 파일은 `gas/` 의 세 개(`Code.gs`, `Index.html`, `appsscript.json`)뿐이다.

1. 스프레드시트를 만든다(시트/헤더는 만들지 않아도 된다).
2. **확장 프로그램 → Apps Script** 를 열고 파일 세 개를 넣는다: `Code.gs` 에 `gas/Code.gs` 내용, **＋ → HTML** 로 만든 파일 `Index`(이름은 확장자 없이 정확히 `Index`. `createHtmlOutputFromFile('Index')` 가 이름으로 찾는다)에 `gas/Index.html` 내용, 매니페스트에 `gas/appsscript.json` 내용(프로젝트 설정의 "appsscript.json 매니페스트 파일 표시"를 켜면 보인다). 또는 `clasp push`([§4](#gas-개발-선택-clasp)) — `gas/` 안에는 이 세 파일만 둔다. `appsscript.json` 은 V8, 시간대 `Asia/Seoul`, 웹 앱 `USER_DEPLOYING`(나로 실행) / `ANYONE_ANONYMOUS`(로그인 없는 모든 사용자)를 선언한다. `oauthScopes` 는 적지 않아 자동 감지에 맡긴다.
3. 편집기에서 **`setup()` 을 한 번 실행**한다. 스프레드시트 접근 권한 승인 화면이 뜨고, 새 프로젝트는 구글 검증을 받지 않았으므로 **"Google에서 확인하지 않은 앱"** 경고가 함께 나올 수 있다(정상). **고급 → (프로젝트 이름)(으)로 이동(안전하지 않음) → 허용** 으로 승인한다. 이 승인이 없으면 `USER_DEPLOYING` 웹 앱은 방문자에게 동작하지 않을 것이다(배포 대화상자가 다시 승인을 요구하면 같은 방법으로. 정확한 순서는 미확인). 승인하면 `SHEET_ID` 속성 저장, `scores` 시트와 7열 헤더 생성, 첫 행 고정, 닉네임 열 텍스트 서식 지정을 한다. 여러 번 실행해도 기존 데이터를 건드리지 않고, 예전 6열 헤더는 7열로 고친다. (`setup()` 은 스프레드시트에서 연 Apps Script 에서만 실행된다.)
4. **배포 → 새 배포 → 유형: 웹 앱**
   - 실행 사용자: **나**
   - 액세스 권한: **모든 사용자**(Anyone). "Google 계정이 있는 모든 사용자" 를 고르면 방문자가 로그인 화면을 받는다.
5. 발급된 `…/exec` 주소를 열면 게임이 나온다 (`/dev` 로 끝나는 테스트 URL 이 아니다). `API_URL` 은 필요 없다.
6. 동작 확인: 주소를 열어 한 판 하고 등록한 뒤 `scores` 시트에 줄이 생겼는지 본다. 외부 클라이언트용 JSON 도 같은 주소로 된다.

```bash
curl -L "https://script.google.com/macros/s/<DEPLOY_ID>/exec?action=ranking&limit=5"   # → {"ok":true,"data":[]}
```

**코드/화면을 고친 뒤**: `js/`, `css/`, `index.html` 을 고쳤다면 `npm run build:gas` → `Index` 파일 내용 교체 → **배포 → 배포 관리 → 편집(연필) → 버전: 새 버전 → 배포**. 이렇게 하면 같은 URL 이 유지된다(새 배포를 만들면 URL 이 바뀐다). 웹 앱 `/exec` 는 **저장된 코드가 아니라 "배포된 버전"** 을 실행하고, `/dev` 는 편집 권한이 있는 사람에게만 열리며 저장된 최신 코드를 실행한다(공식 문서). 생성물이 최신인지는 `npm test`(최신성 검사)와 `npm run check:gas` 가 확인한다.

**다른 사이트의 iframe 에 넣기**: 이 코드는 `setXFrameOptionsMode` 를 부르지 않으므로 Apps Script 의 기본값(`DEFAULT`, 클릭재킹을 막는 기본 보안 가정)이 적용된다. 공식 문서에 따르면 `ALLOWALL` 을 지정해야 아무 사이트나 iframe 으로 넣을 수 있다. 따라서 **다른 사이트에 iframe 으로 끼워 넣는 것은 지원하지도 시험하지도 않았다.** 가장 쉬운 방법은 `/exec` 주소로 링크하는 것이다. 정말 필요하면 `page_()` 의 반환값에 `.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)` 을 이어 붙이면 되지만(미확인), 아무 사이트나 이 화면을 겹쳐 넣을 수 있게 되는 클릭재킹 위험을 감수하는 결정이다.

**방식 B (선택): GitHub Pages + GAS API** — 위 2번에서 `Code.gs`(와 선택적으로 매니페스트)만 넣고 `Index` 파일은 넣지 않아도 된다(주소를 열면 안내 문구가 나오고 JSON API 는 동작한다). 3, 4번을 하고, 발급된 `…/exec` URL 을 `js/config.js` 의 `API_URL` 에 넣어 화면을 따로 호스팅한다. `API_URL` 을 바꾸면 `gas/Index.html` 도 다시 빌드해야 최신성 검사가 통과한다.

> ⚠️ **코드를 수정했을 때** "새 배포"를 만들면 URL이 바뀝니다. **배포 관리 → 편집(연필) → 버전: 새 버전 → 배포**로 같은 URL을 유지하세요.
> ⚠️ 웹 앱은 **저장된 코드가 아니라 "배포된 버전"** 을 실행합니다. 수정 후 재배포를 잊으면 반영되지 않습니다.
> ⚠️ `setup()` 을 건너뛰고 `SHEET_ID` 를 손으로 넣어도 동작은 하지만, 닉네임 열 서식은 첫 제출 때 자동으로 지정됩니다. 그 전에 자동 서식으로 쌓인 행은 원래 글자를 잃을 수 있습니다.

---

## 8. 프런트 ↔ GAS 연동

화면이 서버와 이야기하는 통로는 둘이고 `js/api.js` 가 고른다([§8.2](#82-apijs)). **Apps Script 가 직접 내보낸 화면**에서는 `google.script.run`(같은 스크립트의 함수 호출, CORS/리다이렉트 없음)을, **다른 곳에 호스팅한 화면**(GitHub Pages 등)에서는 `fetch(API_URL)` 를 쓴다. 아래 8.1 은 `fetch` 통로에만 해당한다.

### 8.1 CORS 규칙 (fetch 통로, 가장 흔한 함정)

`fetch(API_URL)` 로 Apps Script 웹 앱을 부를 때(GitHub Pages 방식) Apps Script 웹 앱은 **CORS preflight(OPTIONS)를 처리하지 못합니다.** 따라서:

- `GET`은 그대로 `fetch` 가능.
- `POST`는 `Content-Type: application/json`을 쓰면 preflight가 발생해 **실패**한다. → **`text/plain`으로 보내고 본문에 JSON 문자열**을 담는다 (서버에서 `JSON.parse(e.postData.contents)`로 해석).
- 커스텀 헤더(`Authorization` 등)를 붙이지 않는다.

### 8.2 `api.js`

`js/api.js` 는 **어떤 경우에도 throw/reject 하지 않고** `{ ok, ... }` 로 돌려준다. 호출하는 쪽은 `try/catch` 없이 `ok` 만 보면 된다.

```js
isApiConfigured(opts?)                           // 쓸 수 있는 통로(google.script.run 또는 API_URL)가 있는가
fetchRanking(limit = 10, opts?)  // -> { ok: true, data: [{ nickname, score, maxLevel, at }] } | { ok: false, error }
submitScore({ nickname, score, maxLevel, playTimeMs, drops, clientId }, opts?)  // -> { ok: true } | { ok: false, error }
```

- **통로는 호출할 때마다(import 시점이 아니라) 이 순서로 고른다**: 테스트용 명시 값(`opts.gasRun`, 그다음 `opts.url`) → `window.google.script.run` 이 있으면 그것(`apiRanking`/`apiSubmit`) → `API_URL` 이 있으면 `fetch` → 없으면 `not_configured`. `google.script.run` 은 `withSuccessHandler`/`withFailureHandler` 가 **호출마다 새 실행기**를 돌려주므로 체인을 매번 새로 만들고, 결과 계약은 `fetch` 와 같다(서버 에러 코드는 그대로, 실패 핸들러는 `network`, `ok` 불리언이 없는 결과는 `bad_response`, 8초 `timeout` 뒤 늦게 온 콜백은 무시).
- 에러 코드: 클라이언트가 만드는 `not_configured`(통로 없음), `timeout`(8초), `network`, `bad_response`(JSON 이 아니거나 모양이 다름: 로그인 HTML 페이지 등)와, 서버 코드 `bad_request`, `invalid_nickname`, `invalid_score`, `implausible`, `throttled`, `server_busy`.
- POST 는 `Content-Type: text/plain;charset=utf-8` 하나만 보낸다(위 §8.1). 타임아웃은 `AbortController` 와 `Promise.race` 를 함께 써서, `fetch` 구현이 `signal` 을 무시해도 멈추지 않는다.
- 서버 응답의 행은 검증/정규화한다: 형식이 깨진 행과 보이는 닉네임이 없는 행은 버리고, 숫자는 정수로, `maxLevel` 은 유효 범위로 맞춘다.
- `opts = { gasRun, url, fetchImpl, timeoutMs }` 로 `google.script.run` 대용/URL/`fetch`/타임아웃을 바꿀 수 있어, 테스트가 `config.js` 나 전역 `google` 을 건드리지 않고 Node 에서 돌릴 수 있다. `opts.gasRun`(`null` 포함)이나 `opts.url`(빈 문자열 포함)을 주면 그것이 전역 `google` 보다 앞선다.

### 8.3 UX 원칙

- GAS는 **콜드 스타트로 1~3초** 걸릴 수 있다. 게임 진행을 막지 말고, 결과 화면에서 "랭킹 불러오는 중…" 상태를 보여준다. 응답이 오기 전에 화면을 닫거나 다음 판을 시작했다면 **늦게 도착한 이전 응답은 버린다**(새 화면을 건드리지 않는다).
- 제출 실패(`timeout`/`network`/`bad_response`/`server_busy`/`throttled`) 시 **재시도 버튼**("다시 시도")을 제공하고, 점수는 `localStorage`(`fruit.pendingScore`)에 임시 보관한다. 보관분은 **한 건**(가장 최근에 실패한 판)이다. 다음 접속 때 한 번 **조용히** 다시 보내고(화면에는 아무것도 띄우지 않는다), 성공하거나 서버가 영구적으로 거절한 오류(`invalid_nickname` 등)면 지운다. 다시 재시도 가능한 오류로 실패하면 보관분을 지켜 다음 접속에 또 시도한다. 영구 오류로 거절된 점수는 보관하지 않는다.
- **재시도는 안전하다.** 타임아웃으로 취소해도 서버는 첫 요청을 이미 처리했을 수 있다. 서버가 같은 판의 재전송을 성공으로 처리하므로([§7.3](#73-서버-규칙-요약-gascodegs)) 수동 재시도와 부팅 때 자동 재전송이 중복 행을 만들지 않는다.
- **오프라인 모드**: 쓸 수 있는 통로가 없으면(`google.script.run` 도 `API_URL` 도 없어 `isApiConfigured()` 가 거짓) 결과 화면의 닉네임 폼을 숨기고, 시작 화면의 "랭킹 보기"와 결과 화면의 랭킹 자리에는 "랭킹 서버가 연결되지 않았어요…" 안내를 보여 준다. 네트워크 호출은 하지 않고 최고 점수만 `localStorage` 에 저장되며, 부팅 때 재전송도 건너뛴다. `API_URL` 이 있어도 랭킹 조회가 실패하면 "랭킹을 불러오지 못했어요" 만 보이고 게임은 계속된다.
- 닉네임/랭킹 데이터를 DOM에 넣을 때는 **`textContent`** 를 사용한다 (`innerHTML` 금지 → XSS 방지).
- 점수 제출은 **게임오버 때 1회**. 제출 버튼을 누른 뒤에는 비활성화해 중복 제출을 막는다.

---

## 9. 개발 로드맵(마일스톤)

각 마일스톤은 독립적으로 동작을 확인할 수 있는 단위이며, **하나 끝날 때마다 커밋**합니다.
아래 상태는 **코드와 자동 테스트로 확인한 범위**만 "완료"로 적었습니다. 실기기·실서버·공개 URL 에서의 확인은 사용자 작업이라 "부분"으로 남겨 두었습니다.

| # | 마일스톤 | 작업 | 완료 기준 (DoD) | 상태 |
|---|---|---|---|---|
| M0 | 프로젝트 세팅 | 폴더 구조, `index.html`, Matter.js 로드, 로컬 서버 | 빈 캔버스가 뜨고 콘솔 에러 없음 | **완료** |
| M1 | 물리 프로토타입 | 상자, 클릭 위치에 과일 드롭, 렌더링 | 과일이 떨어져 쌓이고 벽을 뚫지 않음 | **완료** |
| M2 | 합치기 | 충돌 → 합치기 큐 → 다음 단계 생성, 11단계 정의 | 같은 과일이 합쳐지고 수박까지 도달 가능, 중복 합치기 없음 | **완료** |
| M3 | 게임 규칙 | 점수, Next 미리보기, 쿨다운, 경계선, 게임오버, 재시작 | 한 판이 시작→종료→재시작까지 완결됨 | **완료** |
| M4 | UI/UX | HUD, 모바일 터치, 반응형 스케일, 결과 모달, 최고점 저장 | 스마트폰 세로 화면에서 불편 없이 플레이 | **완료** (실기기 확인 남음) |
| M5 | GAS 랭킹 | 시트 + `Code.gs` 배포, `api.js`, 닉네임 입력, 랭킹 표시 | 점수 제출 후 랭킹에 반영, 서버 장애에도 게임 정상 | **부분** (코드와 모의 환경 테스트 완료, 실제 배포 확인 안 함) |
| M6 | 폴리싱 | 효과음/BGM 토글, 합치기 이펙트, 스프라이트 교체, 수박 완성 연출 | 체감 품질 개선, 성능 저하 없음 | **부분** (스프라이트, BGM 없음) |
| M7 | 배포 | Apps Script 웹 앱 하나(기본) 또는 GitHub Pages(선택), README(`README.md` 에 배포 절차/실행/테스트 요약), 최종 QA | `/exec` 공개 주소에서 end-to-end 동작 | **부분** (README 와 배포 파일 완료, 실제 배포 안 함) |
| M8 | Apps Script 단일 호스팅 | `doGet` 이 화면 서빙, `google.script.run` 통로(`apiRanking`/`apiSubmit`), 배포용 한 파일 빌드(`npm run build:gas`), 모의 Apps Script e2e | 웹 앱 주소 하나가 게임이고 랭킹도 같은 스크립트로 동작. 생성물이 항상 최신 | **완료** (코드, 빌드, 모의 환경 테스트까지. 실제 Apps Script 확인은 M7) |

> 우선순위: **M1~M3(재미의 핵심)을 먼저 완성**하고 실제로 해본 뒤 M4 이후로 넘어갑니다. 합치기의 손맛과 밸런스가 안 나오면 이후 작업은 의미가 없습니다.

**완료한 것**: M0~M3 은 물리/규칙 단위 테스트(`tests/physics.test.mjs`, `tests/game.test.mjs`)와 e2e 시나리오가 DoD 를 직접 확인한다. M4 는 세로(390×844, 320×568)·가로·300% 확대 뷰포트를 에뮬레이션한 e2e 가 레이아웃과 터치 드롭, 결과 화면, 최고점 저장을 확인한다. M8 은 빌드 테스트(`tests/build.test.mjs`: 최신성, 결정성, 구조, 외부 자원 없음)와 gas e2e(진짜 `Code.gs` + 진짜 `gas/Index.html` 을 모의 Apps Script 와 sandbox iframe 으로)가 확인한다. 단위/통합 테스트와 두 e2e 묶음(smoke, gas)은 모두 통과한다.

**남은 일** — 아래는 모두 사용자 작업이거나 선택 사항이다.

| 마일스톤 | 남은 일 | 왜 남았나 |
|---|---|---|
| M5, M7, M8 | 스프레드시트 + Apps Script 에 `gas/` 의 세 파일을 올려 웹 앱으로 배포하고 `/exec` 주소에서 게임과 랭킹이 동작하는지 확인([§7.4](#74-배포-절차), [README](../README.md)). 시크릿 창/폰으로 열어 한 판 + 등록 + 시트에 줄 생성까지 | 구글 계정이 필요하다. **실제 Apps Script 에서의 동작(HtmlService 서빙, `google.script.run`, sandbox iframe, 권한 승인 화면, 배포 대화상자, 용량)은 한 번도 확인되지 않았다**(`Code.gs`/`Index.html` 은 모의 Apps Script + 모의 `google.script.run` 으로만 검증). 이 항목이 사실상 마지막 관문이다 |
| M7 | (선택) GitHub Pages 로도 열려면: 코드를 배포 브랜치(`main`)에 병합하고 Pages 켜기(Settings → Pages, `main` / root), 공개 URL 에서 한 판 + 랭킹 등록 확인([§11](#11-배포)) | 저장소 설정과 계정 권한이 필요하다. 기본 배포는 Apps Script 이므로 필수는 아니다 |
| M4, M7 | iOS Safari / Android Chrome 실기기에서 한 판 완주(터치, 오디오, 회전) | e2e 는 헤드리스 Chromium 의 에뮬레이션이다 |
| M6 | 실제 과일 스프라이트 | 지금은 이모지다(감은 🟠 임시). 이미지를 만들어 `assets/fruits/` 에 두고 `FRUITS[i].sprite` 에 URL 을 넣으면 렌더러가 이미지를 그린다. 코드는 준비돼 있고 이미지가 없다 |
| M6 | BGM | 구현하지 않았다. 음소거 버튼은 효과음(Web Audio 합성)을 끈다. 필요 없다면 DoD 에서 BGM 을 뺀다 |
| M6 | 성능 확인 | "성능 저하 없음"은 따로 측정하지 않았다. 저사양 폰에서 프레임을 확인한다 |

---

## 10. 테스트 체크리스트

실제 손맛과 기기별 동작은 **수동 플레이 점검**이 필요하지만, 규칙과 연동은 자동 테스트가 지켜 줍니다([§4 테스트 실행](#테스트-실행)).

| 종류 | 파일 | 보는 것 |
|---|---|---|
| 단위 | `tests/game.test.mjs` | 점수, 가중치 추첨, 상태 머신, 경계선 체류/유예 |
| 단위 | `tests/physics.test.mjs` | 실제 Matter 로 합치기(쌍/3개/수박), 속도 이어받기, 속도 상한, 벽 이탈 방지 |
| 단위 | `tests/render.test.mjs` | `popScale`/`shade`, 경계선 경고(50% 임계, 3Hz), 모션 줄이기 |
| 단위 | `tests/audio.test.mjs`, `tests/storage.test.mjs` | Web Audio 합성/무음 처리, localStorage 안전 래퍼 |
| 단위 | `tests/api.test.mjs` | 클라이언트 요청/응답 정규화를 두 통로(`fetch`, 모의 `google.script.run`)로: 에러 코드 통과, `network`/`bad_response`/8초 `timeout`, 늦게 온 콜백 무시, 호출마다 새 실행기 체인, 통로 우선순위(명시 값 > 전역 `google.script.run` > `API_URL` > `not_configured`, 전역은 **호출 시점**에 본다) |
| 단위 | `tests/gas.test.mjs` | `Code.gs` 를 vm 에서 **모의 Apps Script**(시트/락/캐시/속성/`HtmlService` 를 흉내 낸 객체)로 실행: `doGet` 라우팅(화면 vs JSON, `Index` 누락 시 안내, 템플릿 아님), 검증/거부 코드, 닉네임 정제, 빈도 제한, 재전송, `setup()`, `apiRanking`/`apiSubmit` 이 HTTP 경로와 같은 결과와 같은 시트/빈도 제한을 쓰는지와 절대 throw 하지 않는지, 공개(밑줄 없는) 함수 목록과 익명 호출 안전성, 매니페스트, 타당성 상한 재계산 |
| 단위 | `tests/build.test.mjs` | `gas/Index.html` 이 빌드 결과와 바이트까지 같은지(최신성), 결정성, 구조(인라인 `<style>` 1개 + `<script>` 2개, 클래식 스크립트, 외부 자원 없음, `gas/` 에 세 파일만), 빌더의 실패 경로(표식 변조, 위험 문자열, 외부 자원 주입) |
| 통합 | `tests/integration.test.mjs` | 실제 Matter 로 한 판을 끝까지 돌려 `api.js` → `Code.gs`(모의) 로 흘려 보냄(`fetch` 와 `google.script.run` 두 통로, 같은 시트를 공유). 같은 시드의 결정성도 확인 |
| 정적 | `tests/static.test.mjs` | 뷰포트 메타, 접근성 이름, 색 대비, 레이아웃 계약, `package.json` 계약 |
| e2e | `tests/e2e/smoke.mjs` | 헤드리스 Chromium 로 실제 페이지(가짜 API 서버 사용): 입력, 합치기, 게임오버, 랭킹/제출/재전송, 반응형(세로/가로/300% 확대 에뮬레이션), 키보드, 음소거, 모션 줄이기 |
| e2e | `tests/e2e/gas.mjs` | Apps Script 배포 모의: 진짜 `Code.gs`/`Index.html`, 바깥 래퍼 + sandbox iframe, 모의 `google.script.run`(지연/실패/유실/타임아웃/이상한 결과). 랭킹, 등록(시트 7열), 멱등 재전송, 부팅 시 재전송, 오프라인, fetch 통로, 통로 우선순위(`google-wins`, `late-google`), 저장소가 막힌 iframe, 운영 모습에서 디버그 훅 비노출, 웹 앱 주소 라우팅(`exec-routing`). 진짜 Apps Script 가 아니라 모형이다([§4](#테스트-실행)) |

백엔드 항목은 자동 테스트가 `Code.gs` 를 **모의 서비스 위에서** 확인한 것이다. 실제 스프레드시트/배포에서의 확인은 직접 해야 한다. 아래 체크리스트에서 `(자동)` 표시는 위 테스트가 이미 확인하는 항목이고, 나머지는 기기/서버에서 직접 확인한다.

**물리/합치기**
- [ ] (자동) 같은 과일 2개가 닿으면 정확히 1개의 상위 과일이 생긴다 (중복 생성 없음)
- [ ] (자동) 3개가 한꺼번에 닿아도 2개만 합쳐지고 나머지 1개는 남는다
- [ ] (자동) 합쳐진 과일이 이웃과 겹쳐도 연쇄 합치기가 정상 동작한다
- [ ] (자동) 수박 2개 → 소멸 + 보너스 점수
- [ ] (자동) 과일이 벽/바닥을 뚫고 나가지 않는다 (빠르게 떨어뜨려도)
- [ ] 60Hz / 120Hz 모니터에서 물리 속도가 동일하다 (고정 타임스텝이라 결정적이며 `integration` 이 같은 시드의 같은 결과를 확인하지만, 실제 모니터에서는 직접 본다)

**게임 규칙**
- [ ] (자동) 드롭 직후 과일이 경계선 위에 있어도 게임오버가 되지 않는다
- [ ] (자동) 경계선을 넘은 채 2초 유지되면 게임오버, 도중에 내려가면 취소된다
- [ ] (자동) 쿨다운 중 입력이 무시된다
- [ ] (자동) 재시작 시 이전 판의 바디/타이머/점수가 남아 있지 않다
- [ ] 탭을 백그라운드로 보냈다 돌아와도 물리가 폭주하지 않는다 (e2e 는 메인 스레드 정체로 흉내 낸다. 실제 탭 전환은 직접)

**UI/기기**
- [ ] iOS Safari / Android Chrome / 데스크톱 Chrome에서 입력이 동작한다 (e2e 는 Chromium 에뮬레이션뿐)
- [ ] 화면 회전·창 크기 변경 시 캔버스가 올바르게 스케일된다 (가로 모드에서도 게임판이 크고, 시작 버튼/닉네임 입력/등록 버튼이 보인다)
- [ ] (자동, 뷰포트 에뮬레이션) 브라우저 확대(200~300%)를 해도 HUD/진화 줄이 잘리지 않는다
- [ ] (자동) OS 의 모션 줄이기를 켜면 경계선 경고가 깜빡이지 않고 파티클/튀기 효과가 없다
- [ ] 스크롤/확대/길게 누르기 메뉴가 게임 조작을 방해하지 않는다
- [ ] 오디오가 첫 터치 이후 재생된다 (e2e 는 컨텍스트 연결만 확인한다. 실제 소리와 iOS 는 직접)

**백엔드** (실제 배포 후 확인)
- [ ] 정상 제출 → 시트에 한 행이 추가되고 랭킹에 반영된다 (모의 서비스로는 자동)
- [ ] (자동, 모의) 빈 닉네임, 긴 닉네임, `=1+1` 같은 닉네임 처리
- [ ] (자동, 모의) 음수/비정수/과도한 점수, 드롭 수와 맞지 않는 점수 → 거부
- [ ] 동시에 여러 번 제출해도 행이 유실/중복되지 않는다 (진짜 `LockService` 는 직접)
- [ ] (자동, 모의) 응답이 유실된 뒤 같은 판을 다시 보내도(수동 재시도, 다음 접속 때 자동 재전송) 행이 하나만 있다
- [ ] `3-4`, `1/2`, `007` 같은 닉네임이 그대로 저장되고 랭킹에 보인다 (서식 지정 호출은 자동으로 확인하지만, 실제 시트의 동작은 직접)
- [ ] (자동, 모의) 한글 채움 문자(U+3164 등)나 점자 빈칸(U+2800)만으로 된 닉네임은 거부된다
- [ ] (자동) `API_URL` 미설정, 네트워크 차단 상태에서도 게임이 플레이된다

**Apps Script 단일 배포** (실제 배포 후 확인)
- [ ] (자동) 커밋된 `gas/Index.html` 이 빌드 결과와 같고 외부 자원(CDN, 폰트, 상대 경로)이 없다
- [ ] (자동, 모의) `doGet` 이 `action` 없음/빈 값이면 화면, `ranking` 이면 JSON, 그 밖은 `bad_request`. `Index` 가 없으면 스택 없는 안내
- [ ] (자동, 모의) 공개 함수는 `doGet`, `doPost`, `setup`, `apiRanking`, `apiSubmit` 뿐이고 모두 익명 호출에 안전하다
- [ ] (자동, 모의) 화면이 sandbox iframe 안에서 `google.script.run` 으로 랭킹 조회/등록/재전송을 한다
- [ ] 실제 `/exec` 주소를 **시크릿 창과 폰**에서 열면 게임이 뜨고(제목, viewport 적용 포함) 한 판 + 닉네임 등록이 되며 시트에 한 줄이 생긴다
- [ ] 배포 대화상자의 설정(나로 실행 / 모든 사용자)과 권한 승인 흐름이 문서대로다 (`setup()` 승인 후 방문자가 정상 이용)
- [ ] 실제 iframe 안에서 `localStorage` 가 되는지, 안 되면 메모리 대체로 정상인지 (최고점/닉네임 기억)
- [ ] 구글 계정을 여러 개 로그인한 브라우저에서도 열리는지
- [ ] 코드를 고친 뒤 **새 버전**으로 재배포하면 같은 주소에 반영된다

---

## 11. 배포

### 기본: Apps Script 웹 앱 하나 (게임 + 랭킹)

[§7.4](#74-배포-절차) 의 방식 A. `gas/` 의 세 파일(`Code.gs`, `Index.html`, `appsscript.json`)을 올리고 웹 앱으로 배포하면 `/exec` 주소가 게임이다. 배포 전에 `npm run build:gas` 로 `gas/Index.html` 이 최신인지 확인한다(`npm test` 의 최신성 검사와 `npm run check:gas` 가 같은 것을 확인한다). 이후 수정은 같은 배포를 **새 버전**으로 갱신해 주소를 유지한다. 소유자(비개발자)가 따라 할 단계는 [README](../README.md) 에 있다.

### (선택) 화면을 GitHub Pages 에, 랭킹은 Apps Script 에

방식 B. 이 경우 개발용 화면(`index.html` + ES Module)을 그대로 올리고 `js/config.js` 의 `API_URL` 에 Apps Script `/exec` 주소를 넣는다.

1. 저장소 **Settings → Pages**
2. Source: `Deploy from a branch`, Branch: `main` / `(root)`
3. `https://<계정>.github.io/<저장소>/` 로 접속 확인
4. 상대 경로(`./js/main.js` 등. 스프라이트를 추가하면 `./assets/...`)만 사용해 서브 경로에서도 동작하게 한다.

화면에는 빌드 단계가 없어 저장소가 그대로 배포물이다(`tests/` 와 `docs/` 는 올라가도 쓰이지 않고, `node_modules/` 는 `.gitignore` 라 올라가지 않는다). 배포할 브랜치(위에서는 `main`)에 이 코드가 병합되어 있어야 한다. **Pages 를 켜는 것은 저장소 소유자의 작업**이라 완료로 기록하지 않았다([§9](#9-개발-로드맵마일스톤)). `API_URL` 은 번들(`gas/Index.html`)에도 들어가므로 바꾸면 `npm run build:gas` 도 다시 한다.

### 백엔드 → Apps Script 웹 앱

[§7.4](#74-배포-절차) 참고. 방식 B 에서는 프런트 배포 후 `API_URL`이 올바른지 **실제 공개 URL에서** 한 번 더 확인합니다.

### 릴리스 전 최종 점검

- [ ] 콘솔에 에러/경고 없음
- [ ] `npm test` 와 `npm run test:e2e` 통과 (둘 다 `API_URL` 값과 무관하게 동작한다). `npm test` 에는 `gas/Index.html` 최신성 검사가 포함돼 있다
- [ ] 방식 A: 올린 `Index` 파일이 `gas/Index.html` 과 같고(붙여 넣기가 끝까지 됐는지: 파일 끝이 `</html>`), **새 버전으로 배포**했고, `/exec` 주소를 **시크릿 창/폰**에서 열어 한 판 + 등록까지 확인 (방식 B: `API_URL`이 운영 배포 URL)
- [ ] 시트에 테스트 데이터 정리
- [ ] 모바일 실기기에서 한 판 완주

---

## 12. 보안과 주의사항

**클라이언트가 보내는 점수는 신뢰할 수 없습니다.** 정적 프런트 + GAS 구조에서는 개발자 도구로 점수를 위조하는 것을 완전히 막을 수 없습니다. 목표는 "막는 것"이 아니라 **"쉽게 망가지지 않게 하는 것"** 입니다.

| 단계 | 대책 | 비고 |
|---|---|---|
| 기본 (M5) | 서버에서 형식/범위 검증, 닉네임 정제, 점수 상한, `playTimeMs`·`drops` 대비 점수 타당성 검사 | §7.3 / `gas/Code.gs` |
| 보강 | 판 시작 시 서버가 **세션 토큰** 발급 → 제출 시 토큰 + 경과 시간 검증, 토큰 1회용 | 랭킹이 공개되어 어뷰징이 보일 때 |
| 기본 (구현됨) | `CacheService`로 `clientId` 기준 **제출 빈도 제한**(10초) + 같은 판의 재전송은 성공으로 처리해 중복 행 방지 | §7.3. `clientId` 는 브라우저가 만드는 값이라 우회할 수 있다 |
| 운영 | 시트에서 이상 행을 수동 삭제 → 캐시 만료(최대 60초) 후 반영 | |

**기타 주의**

- 스프레드시트는 **공유하지 않는다** (스크립트가 "나" 권한으로 접근하므로 공개할 필요 없음). 랭킹은 GAS API로만 노출한다.
- 웹 앱은 **"나로 실행 / 모든 사용자"** 라 누구나(로그인 없이) 주소를 열고 서버 함수를 부를 수 있고, 함수는 내 권한으로 실행된다. 그래서 방문자가 부를 수 있는 함수(`google.script.run` 은 이름이 `_` 로 끝나지 않는 최상위 함수를 모두 노출한다)를 `doGet`/`doPost`/`setup`/`apiRanking`/`apiSubmit` 으로 한정하고 모두 익명 호출에 안전하게 둔다([§7.2](#72-api-명세)). `google.script.run` 통로도 HTTP 통로와 같은 검증을 거치므로 새 공격면이 늘지 않는다(개발자 도구로 `google.script.run.apiSubmit(...)` 을 직접 불러도 같은 규칙으로 걸러진다).
- 시트에 쓰는 문자열은 수식 인젝션(`= + - @` 시작)을 막는다 → `gas/Code.gs` 의 `sanitizeNickname_`.
- `?debug` 훅은 같은 브라우저 안의 테스트 도구일 뿐 새로운 권한을 주지 않는다. 점수 검증은 서버가 하며, 클라이언트 점수 위조는 위 표의 한계 안에서만 막는다.
- 화면에 출력할 때는 `textContent` 사용 (XSS).
- GAS는 호출 횟수·동시 실행에 **쿼터**가 있다. 랭킹은 캐시(60초)를 쓰고, 프런트는 결과 화면에서만 호출한다.
- `API_URL`(배포 ID)은 공개되어도 되는 값이지만, **스프레드시트 ID나 다른 비밀 값은 프런트 코드에 넣지 않는다.** `gas/Index.html` 은 누구에게나 내려가는 공개 파일이다(스프레드시트 ID 는 서버의 스크립트 속성에만 있다).

---

## 13. 열린 결정사항

아래는 가이드가 **임시로 정해 둔 기본값**입니다. 바꾸고 싶은 항목이 있으면 알려주세요.

| # | 항목 | 기본값 | 대안 |
|---|---|---|---|
| 1 | GAS의 역할 | 게임 화면 서빙(`HtmlService`) + 랭킹 저장/조회 | 랭킹 API 만(화면은 다른 곳), 단순 방문 통계 |
| 2 | 프런트 호스팅 | **GAS `HtmlService`(웹 앱 하나, 방식 A)** | GitHub Pages(방식 B), Netlify 등 |
| 3 | 수박을 만들었을 때 | **클리어 연출 후 계속 플레이**(엔드리스) | 즉시 게임 종료/승리 처리 |
| 4 | 수박 + 수박 | 소멸 + 보너스 +100 | 소멸만 / 그대로 두기 |
| 5 | 과일 그래픽 | 이모지(임시) → 이후 스프라이트 | 처음부터 직접 제작한 이미지 사용 |
| 6 | 랭킹 대상 | 닉네임 입력(로그인 없음) | 구글 로그인 연동 |
| 7 | 언어 | 한국어 UI | 다국어 |
| 8 | 감 아이콘 | 🟠 (이모지에 감이 없음) | 스프라이트 제작 시 교체 |
| 9 | 닉네임의 ZWJ/ZWNJ(U+200D/200C) | 제거한다. 그래서 `👩‍💻` 같은 합성 이모지는 `👩💻` 로 갈라지고, 제로폭 문자만으로 된 이름은 거부된다 | 글자 사이의 ZWJ/ZWNJ 는 보존하고 맨 앞/뒤/단독일 때만 제거(합성 이모지 유지, 구현이 더 복잡) |
| 10 | 배포용 `gas/Index.html` | **생성물을 커밋한다**(소유자가 Node 없이 파일을 복사해 붙여 넣을 수 있게. 최신성은 `npm test` 가 강제) | 커밋하지 않고 릴리스 때마다 빌드/CI 로 만든다 |
| 11 | 다른 사이트 iframe 삽입 | 지원하지 않는다(`X-Frame-Options` 를 건드리지 않아 Apps Script 기본값. 링크로 연결) | `page_()` 에 `setXFrameOptionsMode(ALLOWALL)` 추가(클릭재킹 방어를 포기하는 대가, 미검증) |

---

### 참고

- Matter.js 문서: https://brm.io/matter-js/docs/
- Apps Script 웹 앱: https://developers.google.com/apps-script/guides/web
- 배포와 버전: https://developers.google.com/apps-script/concepts/deployments
- HTML 서비스(`HtmlService`, `google.script.run`, 제약): https://developers.google.com/apps-script/guides/html
- 매니페스트: https://developers.google.com/apps-script/concepts/manifests
- clasp: https://github.com/google/clasp
- esbuild: https://esbuild.github.io/
