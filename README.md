# 🍉 수박 합치기

같은 과일을 합쳐 더 큰 과일로 만들고, 상자 밖으로 넘치기 전에 **수박**을 완성하는 퍼즐 게임입니다.
화면은 HTML5 Canvas + [Matter.js](https://brm.io/matter-js/), 랭킹은 Google Sheets 에 저장하며, **Google Apps Script 웹 앱 하나**로 게임 화면과 랭킹을 함께 배포합니다(GitHub Pages 불필요).

설계, 규칙, 수치의 이유, 진행 상황(마일스톤 표)은 [`docs/DEVELOPMENT_GUIDE.md`](docs/DEVELOPMENT_GUIDE.md) 에 있습니다.

> **현재 상태**: 게임과 랭킹 코드, 배포용 파일(`gas/`)은 완성되어 있고 자동 테스트가 있습니다. 다만 **실제 Apps Script 에 올려서 확인하는 일은 아직 아무도 하지 않았습니다.** 자동 테스트는 Apps Script 를 흉내 낸 모의 환경에서 돌립니다. 아래 배포 절차를 한 번 따라 해 보고, 되지 않는 곳이 있으면 알려 주세요. 과일 그림은 이모지입니다(감은 🟠 임시).

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

## Apps Script 로 배포하기 (권장: 게임 + 랭킹을 웹 앱 하나로)

웹 앱 주소(`…/exec`) 하나가 게임 화면이고, 랭킹도 같은 스크립트가 처리합니다. **Node 도 터미널도 필요 없습니다.** [`gas/`](gas/) 폴더의 파일 **세 개**를 복사해 붙여 넣으면 됩니다.

| 파일 | Apps Script 에서 | 역할 |
|---|---|---|
| [`gas/Code.gs`](gas/Code.gs) | `Code.gs` | 화면 제공 + 랭킹 서버 |
| [`gas/Index.html`](gas/Index.html) | HTML 파일 `Index` | 게임 전체를 한 파일로 묶은 것(약 175KB, 인터넷에서 따로 받는 것이 없음) |
| [`gas/appsscript.json`](gas/appsscript.json) | `appsscript.json` | 설정(V8, 시간대 Asia/Seoul, 웹 앱: 나로 실행 / 모든 사용자 접근) |

> 파일은 이 저장소 페이지에서 열어 내용을 복사하거나(파일 보기 화면의 Raw / 복사 버튼, 이름은 화면에 따라 다를 수 있음), **Code → Download ZIP** 으로 받아서 메모장 등으로 열어 전체 복사하면 됩니다.
> **저장소 맨 위의 `index.html`(소문자)이 아니라 `gas/Index.html` 을 쓰세요.** 맨 위 것은 개발용이라 Apps Script 안에서는 동작하지 않습니다.
>
> 이 절은 Google 공식 문서(배포, 매니페스트, HtmlService)와 맞춰 썼지만 실제로 따라 해 본 것은 아닙니다. 한국어 메뉴 이름은 Google 이 바꿀 수 있고, **(미확인)** 이 붙은 항목은 공식 문서로도 확인하지 못한 경험칙입니다.

### 배포 순서

1. **스프레드시트 만들기**: [Google 스프레드시트](https://sheets.google.com)에서 새 문서를 만듭니다. 시트 이름과 헤더는 4번의 `setup()` 이 만들어 주므로 비워 둡니다. 이 스프레드시트는 **공유하지 마세요**(스크립트가 내 권한으로 접근하므로 공개할 필요가 없습니다).
2. **Apps Script 열기**: 그 스프레드시트에서 **확장 프로그램 → Apps Script**. 반드시 스프레드시트 안에서 연 스크립트여야 합니다(따로 만든 독립 스크립트에서는 `setup()` 이 실패합니다).
3. **파일 세 개 넣기**
   - **`Code.gs`**: 편집기의 기본 내용(`function myFunction() {}`)을 모두 지우고 `gas/Code.gs` 전체를 붙여 넣습니다.
   - **`Index`**: 왼쪽 파일 목록 위의 **＋ → HTML** 로 새 파일을 만들고 이름을 정확히 **`Index`** 로 합니다(대소문자 구분. `.html` 은 자동으로 붙으니 직접 쓰지 않습니다). 기본 내용을 모두 지우고 `gas/Index.html` 전체를 붙여 넣습니다. 파일은 `<!doctype html>` 로 시작하고 그 바로 아래에 `<!-- GENERATED … -->` 주석이 있습니다. 둘 다 지우지 말고 그대로 붙여 넣으세요. 크기가 커서 붙여 넣는 데 몇 초 걸릴 수 있습니다.
   - **`appsscript.json`**: 왼쪽 **프로젝트 설정(톱니 아이콘) → "'appsscript.json' 매니페스트 파일 편집기에 표시"** 를 체크하면 파일 목록에 `appsscript.json` 이 나타납니다. 그 내용을 `gas/appsscript.json` 내용으로 바꿉니다. 끝나면 그 체크는 꺼도 됩니다.
   - 세 파일을 모두 **저장**합니다(디스크 아이콘 또는 `Ctrl+S`).
4. **`setup()` 한 번 실행 + 권한 승인**: 편집기 위쪽 함수 선택 칸에서 `setup` 을 고르고 **실행**합니다. 권한 검토 창이 뜨면 내 계정을 고릅니다. 그다음 **"Google에서 확인하지 않은 앱"**(This app isn't verified) 경고 화면이 나올 수 있습니다. 내가 직접 만든 스크립트라서 나오는 것이므로 멈추지 말고 **고급 → (프로젝트 이름)(으)로 이동(안전하지 않음) → 허용** 순서로 누릅니다. 실행 로그에 `SHEET_ID 저장 완료` 가 나오고 스프레드시트에 `scores` 시트가 생기면 성공입니다. 여러 번 실행해도 기존 데이터는 그대로입니다. 이 승인을 끝내야 웹 앱이 방문자에게 동작합니다(미확인: 배포 단계에서 승인을 다시 요구하면 같은 방법으로 승인하세요).
5. **웹 앱으로 배포**: **배포 → 새 배포** → 유형 선택(톱니 아이콘)에서 **웹 앱** → 아래처럼 설정하고 **배포**합니다. 설명은 아무거나 적어도 됩니다.
   - 다음 사용자로 실행(Execute as): **나(Me)**
   - 액세스 권한이 있는 사용자(Who has access): **모든 사용자(Anyone)**. "Google 계정이 있는 모든 사용자(Anyone with Google account)" 가 아닙니다. 그걸 고르면 방문자가 로그인 화면을 받습니다.
   - 3번의 `appsscript.json` 이 이 값들을 이미 담고 있어 기본값으로 채워질 수 있지만(미확인), 꼭 눈으로 확인하세요.
6. **주소 열기**: 배포가 끝나면 나오는 **웹 앱 URL** 을 복사합니다. `https://script.google.com/macros/s/…/exec` 로 끝나야 하고 `/dev` 로 끝나는 테스트 주소가 아닙니다. 이 주소를 열면 게임이 나옵니다. **이 주소만 알려 주면 됩니다.**
7. **동작 확인**: ① 주소 뒤에 `?action=ranking` 을 붙여 열면 `{"ok":true,"data":[]}` 같은 글자가 보여야 합니다(랭킹 서버가 켜져 있다는 뜻). ② 로그인하지 않은 상태와 같은 조건으로 **시크릿 창이나 폰**에서 주소를 열어 한 판 하고, 게임 오버 화면에서 닉네임으로 **랭킹 등록**을 눌러 봅니다. ③ 스프레드시트 `scores` 시트에 줄이 생겼는지 봅니다.

### 나중에 고쳐서 다시 올리기

1. 편집기에서 바뀐 파일의 내용을 바꿔 붙여 넣고 저장합니다(`Code.gs` 를 고쳤다면 그것도, 게임을 고쳤다면 다음 절의 방법으로 만든 `Index`).
2. **배포 → 배포 관리 →** 해당 배포의 연필(편집) 아이콘 **→ 버전: 새 버전 → 배포**.

주소는 그대로입니다. **"새 배포"를 또 만들면 주소가 새로 생기니 쓰지 마세요.** 웹 앱의 `/exec` 주소는 저장된 최신 코드가 아니라 **배포된 버전**을 실행하므로, 저장만 하고 2번을 빼먹으면 반영되지 않습니다. 반대로 `/dev` 로 끝나는 테스트 주소는 편집 권한이 있는 사람에게만 열리고 저장된 최신 코드를 실행합니다(공식 문서 기준). 손님에게는 항상 `/exec` 를 알려 주세요.

### 게임을 고친 뒤 `Index.html` 다시 만들기 (개발자용)

`gas/Index.html` 은 `index.html` + `css/` + `js/` + Matter.js 를 한 파일로 묶은 **생성물**이라 직접 고치지 않습니다. 원본을 고친 뒤 다시 만듭니다.

```bash
npm ci                 # 한 번: 의존성 설치 (Node 20 이상)
npm run build:gas      # gas/Index.html 다시 만들기
npm run check:gas      # (선택) 커밋된 gas/Index.html 이 최신인지만 확인
```

- 원본을 고치고 빌드를 잊으면 `npm test` 의 **최신성 검사가 실패**합니다(커밋된 `gas/Index.html` 이 빌드 결과와 한 바이트라도 다르면 실패).
- 빌드는 같은 입력이면 항상 같은 결과를 냅니다. `index.html` 의 표식이 사라졌거나, 묶음 안에 `</script`, `<!--` 같은 HTML 을 깨뜨릴 수 있는 문자열이 있으면 이유를 알려 주고 실패합니다.
- `js/config.js` 의 `API_URL`(아래 GitHub Pages 용)도 묶음 안에 들어가므로 바꾸면 다시 빌드해야 합니다. Apps Script 단독 배포에서는 `API_URL` 을 비워 둡니다(화면이 `google.script.run` 으로 서버를 직접 부르므로 쓰이지 않습니다).
- 다시 만든 `gas/Index.html` 을 위 "나중에 고쳐서 다시 올리기"대로 붙여 넣고 새 버전으로 배포합니다.

### 문제가 생기면

- **주소를 열었더니 "게임 화면 파일(Index.html)을 불러오지 못했습니다" 라는 글만 나온다** → 3번의 `Index` 파일이 없거나 이름이 다릅니다(대소문자 구분, `Index.html` 처럼 확장자를 직접 쓰면 안 됩니다). 고친 뒤에는 새 버전으로 다시 배포해야 합니다. 편집기 왼쪽의 **실행(Executions)** 기록에 `Unknown file: Index` 같은 오류가 남을 수 있습니다(메뉴 이름과 정확한 문구는 미확인).
- **화면이 하얗다 / 버튼이 눌리지 않는다** → ① `Index` 붙여 넣기가 중간에 끊겼는지(파일 맨 끝이 `</html>` 인지) 확인하세요. ② 저장소 맨 위의 `index.html` 을 붙여 넣은 것은 아닌지 확인하세요. ③ 구글 계정을 여러 개 로그인해 둔 브라우저에서 웹 앱이 열리지 않는 경우가 있다고 알려져 있습니다(미확인). 시크릿 창이나 계정을 하나만 쓰는 브라우저에서 열어 보세요.
- **Google 로그인 화면이 나온다** → 5번의 액세스 권한이 "모든 사용자" 가 아닙니다. 고쳐서 다시 배포하세요.
- **"권한이 필요합니다", "스크립트 함수를 찾을 수 없습니다: doGet" 같은 오류** → 권한 승인(4번)을 끝내지 않았거나, `Code.gs` 를 저장하지 않았거나, 코드를 고친 뒤 새 버전으로 재배포하지 않은 경우입니다(오류 문구는 미확인).
- **게임은 나오는데 랭킹이 안 된다** → "랭킹 서버가 연결되지 않았어요" 는 화면이 `google.script.run` 도 `API_URL` 도 찾지 못했다는 뜻입니다. `Index.html` 파일을 내 컴퓨터에서 바로 열었거나 다른 곳에 올린 경우가 아니라면 나오지 않습니다. "랭킹을 불러오지 못했어요", "서버가 바빠요" 는 서버가 실패한 것입니다. 4번의 `setup()` 과 권한 승인을 끝냈는지, `scores` 시트를 지우지 않았는지, 고친 뒤 재배포했는지 확인하세요. 서버는 이유를 화면에 보여 주지 않고 편집기의 **실행(Executions)** 기록에만 남깁니다.
- **"서버 응답이 늦어요"** → 한동안 쓰지 않은 Apps Script 는 첫 응답이 느릴 수 있습니다(미확인). 다시 시도하면 됩니다.
- **시트에서 이상한 줄을 지웠는데 랭킹에 그대로 보인다** → 랭킹은 60초 동안 캐시됩니다. 1분 뒤에 반영됩니다.
- **새로고침하면 닉네임/최고 점수가 사라진다** → Apps Script 는 화면을 Google 의 격리된 프레임 안에서 보여 주는데, 브라우저에 따라 그 안에서 저장소(localStorage)가 막힐 수 있습니다(미확인). 그러면 게임은 계속 동작하지만 이번 접속 동안만 기억합니다. 서버에 등록된 랭킹에는 영향이 없습니다.
- **주소창에 `?debug` 를 붙여도 개발용 훅이 생기지 않는다** → 정상입니다. 화면이 격리된 프레임 안에서 열려 방문자의 주소 쿼리가 프레임에 전달되지 않기 때문입니다(미확인). 테스트는 로컬 하네스에서 합니다.

### 다른 사이트에 끼워 넣기 (iframe)

가장 쉬운 방법은 **링크**(또는 새 탭으로 여는 버튼)로 `/exec` 주소를 걸어 두는 것입니다. 이 코드는 Apps Script 의 `X-Frame-Options` 설정을 건드리지 않습니다(`setXFrameOptionsMode` 를 부르지 않음). 그러므로 Apps Script 의 기본값이 적용되는데, 공식 문서에 따르면 기본값(`DEFAULT`)은 다른 사이트의 iframe 에 넣는 것을 막는 쪽으로 동작할 수 있고 `ALLOWALL` 을 지정해야 어느 사이트든 넣을 수 있습니다. 따라서 **다른 사이트의 iframe 안에서 열리는지는 이 프로젝트가 보장하지도, 시험해 보지도 않았습니다.** 꼭 필요하다면 개발자가 `Code.gs` 의 `page_()` 에 `.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)` 를 덧붙여야 하고, 그러면 아무 사이트나 이 화면을 겹쳐 넣을 수 있게 되는(클릭재킹 방어가 사라지는) 대가가 따릅니다.

### (선택) clasp 로 올리기

붙여 넣기 대신 터미널로 올리려면 [clasp](https://github.com/google/clasp) 를 씁니다. Node 가 필요하고, 위 1~2번(스프레드시트와 Apps Script 프로젝트 만들기)은 똑같이 먼저 해야 합니다. 아래는 일반적인 clasp 사용법이며 이 프로젝트에서 실제로 실행해 보지는 않았습니다(미확인).

```bash
npm ci && npm run build:gas       # gas/Index.html 을 최신으로
npm i -g @google/clasp
clasp login
# 저장소 맨 위에 .clasp.json 을 직접 만든다 (.gitignore 에 들어 있어 커밋되지 않는다). 스크립트 ID 는 Apps Script 의 프로젝트 설정에 있다.
#   { "scriptId": "<스크립트 ID>", "rootDir": "gas" }
clasp push                        # gas/ 의 파일 세 개를 올린다
```

- `clasp clone` 은 반대로 Apps Script 의 파일을 `gas/` 로 내려받아 이 저장소의 파일을 덮어쓸 수 있으니 쓰지 마세요.
- `gas/` 폴더는 clasp 가 통째로 올리므로 **`Code.gs`, `Index.html`, `appsscript.json` 외에는 아무것도 두지 않습니다**(테스트가 지킵니다).
- `clasp push` 는 저장된 코드만 바꿉니다. 웹 앱 `/exec` 에 반영하려면 여전히 **배포 → 배포 관리 → 편집 → 새 버전 → 배포** 가 필요합니다. 처음 한 번은 `setup()` 실행과 권한 승인도 편집기에서 해야 합니다.

## 로컬에서 실행 (개발용)

개발용 화면(`index.html` + ES Module)은 `file://` 로 열면 동작하지 않으므로 로컬 서버가 필요합니다. 설치할 것은 없습니다(Python 3 만 있으면 됩니다).

```bash
npm run serve                 # = python3 -m http.server 8000
# 또는
python3 -m http.server 8000
# → http://localhost:8000
```

- 개발용 화면은 Matter.js 를 CDN(cdnjs, 0.19.0 고정)에서 불러오므로 인터넷 연결이 필요합니다. (Apps Script 용 `gas/Index.html` 에는 Matter.js 가 통째로 들어 있어 외부에서 받는 것이 없습니다.)
- 같은 Wi-Fi 의 폰에서는 `http://<PC의 IP>:8000` 으로 접속합니다.
- `js/config.js` 의 `API_URL` 이 비어 있고 `google.script.run` 도 없으면 **오프라인 모드**입니다. 랭킹 서버 없이 플레이되고 결과 화면에 닉네임 입력/랭킹 등록이 나오지 않습니다.
- 서버와 연결하는 통로는 호출할 때마다 `google.script.run`(Apps Script 안) → `fetch(API_URL)`(다른 곳에 호스팅) → 오프라인 순서로 고릅니다.

## 테스트

Node 20 이상(`.nvmrc` 는 22)이 필요합니다. 개발 의존성(`esbuild`, `matter-js`, `playwright-core`)은 빌드와 테스트에만 쓰이며 Apps Script 에 올라가는 것은 `gas/` 의 세 파일뿐입니다.

```bash
npm ci                  # 한 번: 의존성 설치
npm test                # 단위/통합 테스트 (node --test). gas/Index.html 최신성 검사 포함
npm run e2e:install     # 한 번: e2e 용 Chromium 내려받기
npm run test:e2e        # 헤드리스 Chromium e2e: 개발용 페이지(smoke) + Apps Script 배포 모의(gas)
npm run build:gas       # gas/Index.html 다시 만들기 (js/, css/, index.html 을 고친 뒤)
```

| 명령 | 필요한 것 | 비고 |
|---|---|---|
| `npm test` | Node, `npm ci` 한 번 | 브라우저, 네트워크, Google 계정이 필요 없습니다. `gas/Code.gs` 는 모의 Apps Script(시트/락/캐시/HtmlService 를 흉내 낸 객체) 위에서 실행하고, `gas/Index.html` 은 빌드 결과와 같은지와 구조(외부 자원 없음 등)를 검사합니다. `matter-js` 가 없으면 물리 테스트는 건너뛰고, `CI` 환경변수가 있으면 실패로 처리합니다 |
| `npm run test:e2e` | Chromium (`npm run e2e:install`, 또는 `CHROMIUM_PATH`) | 두 묶음을 차례로 돌립니다. **smoke**: 개발용 페이지를 자체 서버(무작위 포트)로 띄우고 Matter.js 는 `node_modules` 의 같은 버전을 쓰므로 네트워크가 필요 없습니다. `js/config.js` 의 `API_URL` 과 무관합니다(하네스가 `''` 또는 가짜 URL 로 바꿔 서빙). **gas**: 진짜 `gas/Code.gs` 와 `gas/Index.html` 을 Apps Script 처럼(바깥 페이지 + sandbox iframe + 모의 `google.script.run`) 서빙합니다. 각각 `npm run test:e2e:smoke`, `npm run test:e2e:gas` |
| `npm run build:gas` / `npm run check:gas` | Node, `npm ci` 한 번 | `gas/Index.html` 을 만들거나(쓰기) 최신인지만 확인합니다 |

e2e 옵션: `CHROMIUM_PATH=/경로/chrome npm run test:e2e`(설치된 브라우저 사용), `npm run test:e2e:smoke -- --only=a,c` 또는 `npm run test:e2e:gas -- --only=submit`(일부 시나리오만), `-- --headed`(브라우저 창 표시).

자동 테스트가 보장하지 않는 것: 진짜 Apps Script 에서의 동작(HtmlService 서빙, `google.script.run`, 실제 sandbox iframe, 권한 승인, 배포), 실기기(iOS Safari / Android Chrome)에서의 플레이. 이 둘은 직접 확인해야 합니다.

## 프로젝트 구조

```
index.html            개발용 진입점 (캔버스, HUD, 시작/결과/랭킹 오버레이)
css/style.css         스타일 (모바일 우선, 가로/확대 화면 대응)
js/
  config.js           모든 수치: 과일, 월드, 점수, 타이밍, API_URL, 저장 키
  main.js             부트스트랩, 게임 루프, 모듈 연결, ?debug 훅
  game.js             점수/상태 머신/게임오버 판정 (순수 로직)
  physics.js          Matter.js 월드, 합치기 큐
  render.js           Canvas 그리기와 이펙트
  input.js            포인터/키보드 입력
  audio.js            효과음 (Web Audio 합성, 파일 없음)
  storage.js          localStorage 래퍼 (막히면 메모리로 대체)
  api.js              랭킹 서버 통신 (google.script.run 또는 fetch)
gas/                  Apps Script 프로젝트에 올릴 파일 딱 세 개 (clasp 로 올릴 때도 이 폴더 전체가 올라가므로 다른 파일을 두지 않는다)
  Code.gs             Apps Script 백엔드 + 화면 제공 (서버 규칙의 단일 출처)
  Index.html          게임 전체를 한 파일로 묶은 생성물 (직접 고치지 않는다. `npm run build:gas`)
  appsscript.json     매니페스트 (V8, Asia/Seoul, 웹 앱 설정)
scripts/build-gas.mjs index.html + css + js 모듈 + Matter.js 를 gas/Index.html 로 묶는 빌드 (esbuild)
tests/
  *.test.mjs          단위/통합 테스트 (build.test.mjs 가 gas/Index.html 을 검사)
  helpers/gas-env.mjs Code.gs 를 Node 에서 돌리는 모의 Apps Script + 모의 google.script.run
  e2e/                헤드리스 Chromium e2e: smoke.mjs(개발용 페이지), gas.mjs(Apps Script 배포 모의), harness.mjs(공용)
docs/DEVELOPMENT_GUIDE.md   개발 가이드
```

## (선택) GitHub Pages 에 화면, Apps Script 는 랭킹만

Apps Script 하나로 배포했다면 이 절은 건너뛰세요. 화면(`index.html` + ES 모듈)을 GitHub Pages 에 올리고 랭킹 서버만 Apps Script 로 두는 방식입니다. 이 방식은 배포 대상이 둘(Pages + Apps Script)이 되고 CORS 제약([가이드 §8.1](docs/DEVELOPMENT_GUIDE.md#81-cors-규칙-fetch-통로-가장-흔한-함정))을 받습니다.

1. 위 "배포 순서" 1~6번을 따르되 **3번에서 `Code.gs` 만 넣어도 됩니다**(`Index` 파일이 없으면 주소를 열었을 때 안내 문구가 나오고 JSON 랭킹 API 는 동작합니다). 6번에서 복사한 `/exec` 주소가 API 주소입니다. 확인: `curl -L "https://script.google.com/macros/s/<배포 ID>/exec?action=ranking&limit=5"` → `{"ok":true,"data":[]}`
2. [`js/config.js`](js/config.js) 의 `export const API_URL = '';` 에 그 주소를 넣습니다. 랭킹 없이 올려도 됩니다(오프라인 모드).
   ```js
   export const API_URL = 'https://script.google.com/macros/s/<배포 ID>/exec';
   ```
3. `main` 브랜치에 푸시합니다. 저장소 **Settings → Pages → Build and deployment**: Source 는 **Deploy from a branch**, Branch 는 **`main` / `(root)`** 로 저장합니다.
4. 잠시 뒤 `https://<계정>.github.io/<저장소>/` 로 접속해 한 판 해 보고, 랭킹을 설정했다면 등록과 조회까지 **공개 URL 에서** 확인합니다.

경로는 모두 상대 경로(`./js/main.js` 등)라서 `/<저장소>/` 같은 하위 경로에서도 동작합니다. `API_URL` 을 바꾸면 `gas/Index.html` 도 다시 빌드해야 `npm test` 가 통과합니다(위 "게임을 고친 뒤 `Index.html` 다시 만들기").

서버 규칙(점수 타당성 검사, 닉네임 정제, 제출 빈도 제한, 재전송 처리)과 에러 코드는 [가이드 §7](docs/DEVELOPMENT_GUIDE.md#7-google-apps-script-백엔드), 보안상의 한계는 [§12](docs/DEVELOPMENT_GUIDE.md#12-보안과-주의사항)에 있습니다.

## 디버그 훅 (`?debug`)

개발용 주소에 `debug` 파라미터를 붙이면(`/?debug`, `/?debug=1`) `window.__fruit` 가 생겨 시뮬레이션을 결정적으로 제어할 수 있습니다. 파라미터가 없으면 만들어지지 않습니다. e2e 테스트가 이것으로 시간을 진행하고 과일을 배치합니다. Apps Script 로 배포한 화면에서는 주소의 쿼리가 화면에 전달되지 않아 이 훅이 생기지 않습니다(위 "문제가 생기면" 참고).

| 멤버 | 설명 |
|---|---|
| `spawn(level, x, y)`, `bodies()` | 과일 생성 / 현재 과일 목록 |
| `pause()`, `resume()` | 실시간 루프 정지 / 재개 |
| `advance(ms)` | 정지 중에도 `ms` 만큼 시뮬레이션을 진행 |
| `forceGameOver()` | 판을 즉시 끝냄 (시작 전이면 먼저 시작) |
| `getState()`, `getScore()`, `game`, `physics` | 상태 확인과 내부 객체 |

점수 검증은 서버가 하므로 이 훅이 랭킹의 신뢰 경계를 바꾸지는 않습니다(가이드 §6.9, §12).
