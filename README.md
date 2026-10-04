# 🍉 수박 합치기

같은 과일을 합쳐 더 큰 과일로 만들고, 상자 밖으로 넘치기 전에 **수박**을 완성하는 퍼즐 게임입니다.
프런트엔드는 HTML5 Canvas + [Matter.js](https://brm.io/matter-js/)(빌드 도구 없음), 랭킹 백엔드는 Google Apps Script + Google Sheets 입니다.

설계, 규칙, 수치의 이유, 진행 상황(마일스톤 표)은 [`docs/DEVELOPMENT_GUIDE.md`](docs/DEVELOPMENT_GUIDE.md) 에 있습니다.

> **현재 상태**: 게임과 랭킹 코드는 완성되어 있고 자동 테스트가 있습니다. 다만 랭킹 서버는 직접 배포해야 하며(`API_URL` 이 비어 있으면 랭킹 없이 최고 점수만 저장하는 오프라인 모드), 과일 그림은 이모지입니다(감은 🟠 임시).

## 게임 방법

- 같은 과일 두 개가 닿으면 합쳐져 한 단계 큰 과일이 됩니다. 🍒 → 🍓 → 🍇 → 🍊 → 🟠 → 🍎 → 🍐 → 🍑 → 🍍 → 🍈 → 🍉 (11단계)
- 떨어뜨릴 과일은 체리~감(Lv 0~4) 중 무작위(작은 과일이 더 자주)이고, 다음 과일이 위쪽 HUD 에 미리 보입니다.
- 조작
  - 터치: 화면을 누른 채 좌우로 움직여 위치를 정하고, 손을 떼면 떨어집니다.
  - 마우스: 움직여서 위치를 정하고 클릭하면 떨어집니다.
  - 키보드: `←` `→` 이동, `Space` 떨어뜨리기.
- 점수: 합쳐서 새 과일이 만들어질 때마다 그 과일의 점수를 얻습니다(1, 3, 6, 10, … 66). 수박 두 개가 닿으면 둘 다 사라지고 +100.
- 게임 오버: 과일이 상자 위쪽 점선을 넘은 채 2초 이상 머물면 끝납니다. 선에 가까워지면 점선이 붉게 깜빡입니다(OS 의 "모션 줄이기"를 켰다면 깜빡이지 않고 고정된 붉은색).
- 첫 수박을 만들면 클리어 연출이 나오고, 이어서 계속 플레이할 수 있습니다.
- 🔊 버튼으로 효과음을 끌 수 있습니다. 최고 점수, 닉네임, 음소거 설정은 브라우저에 저장됩니다.

## 실행

ES Module 은 `file://` 로 열면 동작하지 않으므로 로컬 서버가 필요합니다. 설치할 것은 없습니다(Python 3 만 있으면 됩니다).

```bash
npm run serve                 # = python3 -m http.server 8000
# 또는
python3 -m http.server 8000
# → http://localhost:8000
```

- Matter.js 는 CDN(cdnjs, 0.19.0 고정)에서 불러오므로 인터넷 연결이 필요합니다.
- 같은 Wi-Fi 의 폰에서는 `http://<PC의 IP>:8000` 으로 접속합니다.
- `js/config.js` 의 `API_URL` 이 비어 있으면 **오프라인 모드**입니다. 랭킹 서버 없이 플레이되고 결과 화면에 닉네임 입력/랭킹 등록이 나오지 않습니다. 서버를 붙이려면 아래 "랭킹 백엔드 설정"을 따릅니다.

## 테스트

Node 20 이상(`.nvmrc` 는 22)이 필요합니다. 개발 의존성(`matter-js`, `playwright-core`)은 테스트에만 쓰이며 배포물에는 들어가지 않습니다.

```bash
npm ci                  # 한 번: 의존성 설치
npm test                # 단위/통합 테스트 (node --test)
npm run e2e:install     # 한 번: e2e 용 Chromium 내려받기
npm run test:e2e        # 헤드리스 Chromium 으로 실제 페이지를 구동하는 스모크 테스트
```

| 명령 | 필요한 것 | 비고 |
|---|---|---|
| `npm test` | Node, `npm ci` 한 번 | 브라우저, 네트워크, Google 계정이 필요 없습니다. `gas/Code.gs` 는 모의 Apps Script 위에서 실행합니다. `matter-js` 가 없으면 물리 테스트는 건너뛰고, `CI` 환경변수가 있으면 실패로 처리합니다 |
| `npm run test:e2e` | Chromium (`npm run e2e:install`, 또는 `CHROMIUM_PATH`) | 자체 서버를 무작위 포트로 띄우고 Matter.js 는 `node_modules` 의 같은 버전을 쓰므로 네트워크가 필요 없습니다. `js/config.js` 의 `API_URL` 과 무관합니다(하네스가 `''` 또는 가짜 URL 로 바꿔 서빙) |

e2e 옵션: `CHROMIUM_PATH=/경로/chrome npm run test:e2e`(설치된 브라우저 사용), `npm run test:e2e -- --only=a,c`(일부 시나리오만), `npm run test:e2e -- --headed`(브라우저 창 표시).

## 프로젝트 구조

```
index.html            진입점 (캔버스, HUD, 시작/결과/랭킹 오버레이)
css/style.css         스타일 (모바일 우선, 가로/확대 화면 대응)
js/
  config.js           모든 수치: 과일, 월드, 점수, 타이밍, API_URL, 저장 키
  main.js             부트스트랩, 게임 루프, 모듈 연결, ?debug 훅
  game.js             점수/상태 머신/게임오버 판정 (순수 로직)
  physics.js          Matter.js 월드, 합치기 큐
  render.js           Canvas 그리기와 이펙트
  input.js            포인터/키보드 입력
  audio.js            효과음 (Web Audio 합성, 파일 없음)
  storage.js          localStorage 래퍼
  api.js              랭킹 서버 통신
gas/
  Code.gs             Apps Script 백엔드 (서버 규칙의 단일 출처)
  appsscript.json     매니페스트 (V8, Asia/Seoul, 웹 앱 설정)
tests/                단위/통합 테스트(*.test.mjs)와 e2e(e2e/smoke.mjs)
docs/DEVELOPMENT_GUIDE.md   개발 가이드
```

## 랭킹 백엔드 설정 (Google Apps Script)

랭킹은 선택 사항입니다. 아래를 마치면 결과 화면에 닉네임 입력과 랭킹이 나타납니다. 스프레드시트는 **공유하지 마세요**(스크립트가 내 권한으로 접근하므로 공개할 필요가 없습니다).

1. **스프레드시트 만들기**: [Google 스프레드시트](https://sheets.google.com)에서 새 문서를 만듭니다. 시트 이름과 헤더는 다음 단계의 `setup()` 이 만들어 주므로 비워 둡니다.
2. **Apps Script 열기**: 그 스프레드시트에서 **확장 프로그램 → Apps Script**. (반드시 스프레드시트 안에서 연 스크립트여야 합니다. 따로 만든 독립 스크립트에서는 `setup()` 이 실패합니다.)
3. **코드 붙여 넣기**: 편집기의 기본 `Code.gs` 내용을 모두 지우고 이 저장소의 [`gas/Code.gs`](gas/Code.gs) 전체를 붙여 넣은 뒤 저장합니다.
   - 선택: **프로젝트 설정(톱니) → "appsscript.json 매니페스트 파일 표시"** 를 켜고 [`gas/appsscript.json`](gas/appsscript.json) 내용을 붙여 넣으면 시간대(Asia/Seoul)와 웹 앱 기본값이 같아집니다.
4. **`setup()` 한 번 실행**: 상단 함수 선택 칸에서 `setup` 을 고르고 **실행**합니다. 권한 승인 창이 뜨면 계정을 고르고 승인합니다("확인되지 않은 앱" 경고가 나오면 **고급 → (프로젝트 이름)으로 이동**). 실행 로그에 `SHEET_ID 저장 완료` 가 나오고, 스프레드시트에 `scores` 시트(7열 헤더, 첫 행 고정)가 생깁니다. 여러 번 실행해도 기존 데이터는 그대로입니다.
5. **웹 앱으로 배포**: **배포 → 새 배포 →** 유형 선택(톱니)에서 **웹 앱** 을 고르고 다음과 같이 설정한 뒤 **배포**합니다.
   - 실행 사용자(Execute as): **나(Me)**
   - 액세스 권한(Who has access): **모든 사용자(Anyone)** — "Google 계정이 있는 모든 사용자" 가 아닙니다. 그걸 고르면 브라우저가 로그인 페이지를 받아 등록이 실패합니다.
6. **URL 복사**: 배포가 끝나면 나오는 웹 앱 URL(`https://script.google.com/macros/s/…/exec`)을 복사합니다. `/dev` 로 끝나는 테스트 URL 이 아니라 `/exec` 여야 합니다. 동작 확인:
   ```bash
   curl -L "https://script.google.com/macros/s/<배포 ID>/exec?action=ranking&limit=5"
   # → {"ok":true,"data":[]}
   ```
7. **`API_URL` 입력**: [`js/config.js`](js/config.js) 의 `export const API_URL = '';` 에 복사한 URL 을 넣고 저장소에 반영합니다.
   ```js
   export const API_URL = 'https://script.google.com/macros/s/<배포 ID>/exec';
   ```
8. **코드를 고친 뒤 재배포(URL 유지)**: 웹 앱은 저장된 코드가 아니라 **배포된 버전**을 실행합니다. **배포 → 배포 관리 →** 해당 배포의 연필(편집) **→ 버전: 새 버전 → 배포**. "새 배포"를 만들면 URL 이 바뀌어 `API_URL` 도 고쳐야 합니다.

서버 규칙(점수 타당성 검사, 닉네임 정제, 제출 빈도 제한, 재전송 처리)과 에러 코드는 [가이드 §7](docs/DEVELOPMENT_GUIDE.md#7-google-apps-script-백엔드), 보안상의 한계는 [§12](docs/DEVELOPMENT_GUIDE.md#12-보안과-주의사항)에 있습니다. 시트에서 이상한 행을 지우면 랭킹에는 최대 60초 뒤에 반영됩니다(캐시). 코드를 저장소로 관리하려면 clasp 를 쓸 수 있습니다(가이드 §4).

## GitHub Pages 배포

빌드 과정이 없으므로 저장소 그대로 올립니다.

1. 위 랭킹 설정을 마치고 `API_URL` 을 반영한 뒤(랭킹 없이 올려도 됩니다) `main` 브랜치에 푸시합니다.
2. 저장소 **Settings → Pages → Build and deployment**: Source 는 **Deploy from a branch**, Branch 는 **`main` / `(root)`** 로 저장합니다.
3. 잠시 뒤 `https://<계정>.github.io/<저장소>/` 로 접속해 한 판 해 보고, 랭킹을 설정했다면 등록과 조회까지 **공개 URL 에서** 확인합니다.

경로는 모두 상대 경로(`./js/main.js` 등)라서 `/<저장소>/` 같은 하위 경로에서도 동작합니다.

## 디버그 훅 (`?debug`)

주소에 `debug` 파라미터를 붙이면(`/?debug`, `/?debug=1`) `window.__fruit` 가 생겨 시뮬레이션을 결정적으로 제어할 수 있습니다. 파라미터가 없으면 만들어지지 않습니다. e2e 테스트가 이것으로 시간을 진행하고 과일을 배치합니다.

| 멤버 | 설명 |
|---|---|
| `spawn(level, x, y)`, `bodies()` | 과일 생성 / 현재 과일 목록 |
| `pause()`, `resume()` | 실시간 루프 정지 / 재개 |
| `advance(ms)` | 정지 중에도 `ms` 만큼 시뮬레이션을 진행 |
| `forceGameOver()` | 판을 즉시 끝냄 (시작 전이면 먼저 시작) |
| `getState()`, `getScore()`, `game`, `physics` | 상태 확인과 내부 객체 |

점수 검증은 서버가 하므로 이 훅이 랭킹의 신뢰 경계를 바꾸지는 않습니다(가이드 §6.9, §12).
