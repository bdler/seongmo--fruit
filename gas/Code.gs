/**
 * 수박 합치기 — Google Apps Script 웹 앱 하나로 게임 화면과 랭킹 서버를 함께 제공한다.
 * (스프레드시트에 바인딩된 스크립트. 파일은 Code.gs, Index.html, appsscript.json 세 개)
 *
 *   GET  (action 없음)               -> 게임 화면 (Index.html). 웹 앱 주소를 그냥 열면 이것이 나온다.
 *   GET  ?action=ranking&limit=10    -> { ok: true, data: [{ nickname, score, maxLevel, at }] }   (외부 클라이언트용 JSON)
 *   POST text/plain JSON 본문         -> { ok: true } | { ok: false, error: '<코드>' }              (외부 클라이언트용 JSON)
 *   google.script.run.apiRanking(limit) / apiSubmit(payload)
 *                                    -> 위 JSON 과 똑같은 결과 객체. 게임 화면이 실제로 쓰는 통로다 (CORS/리다이렉트 없음).
 *
 * 에러 코드: bad_request, invalid_nickname, invalid_score, implausible, throttled, server_busy
 * (서버 내부 오류는 상세를 숨기고 server_busy 로 응답한다. 원인은 실행 로그에만 남는다.)
 *
 * 처음 한 번: 편집기에서 setup() 을 실행한 뒤 웹 앱으로 배포한다.
 *
 * [보안 메모] 이름이 밑줄(_)로 끝나지 않는 최상위 함수는 모두 게임 화면의 google.script.run 으로
 * 방문자(익명 포함)가 직접 호출할 수 있다. 현재 그 목록은 doGet, doPost, setup, apiRanking, apiSubmit 뿐이며
 * 전부 익명 호출에 안전해야 한다 (검증은 모두 서버에서 하고, setup 은 멱등이며 데이터를 지우지 않는다).
 * 새 함수는 밑줄로 끝나게 만든다. tests/gas.test.mjs 가 이 목록이 늘어나면 실패한다.
 */

const SHEET_NAME = 'scores';
const SHEET_HEADERS = ['timestamp', 'nickname', 'score', 'maxLevel', 'playTimeMs', 'drops', 'clientId'];
const PROP_SHEET_ID = 'SHEET_ID';
const PROP_NICKNAME_TEXT = 'NICKNAME_TEXT_FORMAT'; // 닉네임 열을 텍스트로 고정해 둔 시트의 ID

const MAX_NICKNAME = 12;
const MAX_SCORE = 100000;
const MAX_LEVEL = 10;
const MAX_DROPS = 5000;
const MAX_PLAY_TIME_MS = 86400000; // 24h
const MAX_BODY_CHARS = 2000;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

// 점수 상한 근거: 떨어뜨리는 과일은 Lv4 이하라 체리 2^4 = 16개 분량의 질량을 가진다.
// Lv L 과일을 만드는 합치기는 질량 2^L 을 소모하므로 최대 (질량 / 2^L)번이고, 한 번에 (L+1)(L+2)/2 점.
// 수박 2개(질량 2048)가 사라질 때 보너스 100. 질량 1단위당 상한은
//   Σ(L=1..10) (L+1)(L+2)/2 / 2^L + 100/2048 ≈ 6.959  ->  드롭당 16 × 6.959 ≈ 111.3점.
// 여기에 약 8% 여유를 둔 값이다. (tests/gas.test.mjs 가 config.js 로 이 계산을 다시 검증한다)
// 참고: Lv4 이하로 이미 태어난 과일은 그 아래 단계 합치기를 겪지 않으므로 실제 최댓값은 Lv4 만 떨어뜨릴 때의
// 약 28.3점/드롭이다. 이 상한이 그보다 헐거운 것은 점수 규칙이 조금 늘어도 정상 기록을 거부하지 않기 위해서다.
const MAX_SCORE_PER_DROP = 120;
// 게임은 시뮬레이션 시간 기준 500ms 쿨다운을 강제한다. 첫 드롭은 대기 없이 가능하므로 (drops - 1)번의 간격이
// 필요하고, 프레임 지터 여유로 400ms 를 쓴다.
const MIN_MS_PER_DROP = 400;

// 같은 판의 재전송(응답이 유실돼 다시 보낸 경우)을 찾으려고 뒤에서부터 훑는 행 수
const RESUBMIT_SCAN_ROWS = 500;
const THROTTLE_SEC = 10;
const THROTTLE_KEY_PREFIX = 'thr:';
const LOCK_WAIT_MS = 5000;

// 게임 화면: 같은 프로젝트의 HTML 파일 Index (Index.html). 확장자 없이 이름만 쓴다.
const PAGE_FILE = 'Index';
const PAGE_TITLE = '수박 합치기';
// 화면은 Apps Script 가 감싸는 iframe 안에서 열리므로 viewport 는 HTML 안이 아니라 서버에서 넣어야 적용된다.
const PAGE_VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover';
const PAGE_MISSING_MESSAGE =
  '게임 화면 파일(Index.html)을 불러오지 못했습니다.\n' +
  'Apps Script 편집기 왼쪽 파일 목록에서 + → HTML 을 눌러 이름을 Index 로 만들고(.html 은 자동으로 붙습니다), ' +
  '배포 파일 gas/Index.html 의 내용을 통째로 붙여 넣은 뒤 저장하세요.\n' +
  '그다음 배포 → 배포 관리 → 연필(편집) → 버전: 새 버전 → 배포 로 같은 주소를 다시 배포하면 됩니다.';

const RANKING_CACHE_KEY = 'ranking';
const RANKING_CACHE_SEC = 60;
const RANKING_KEEP = 50;
const DEFAULT_LIMIT = 10;

// 제어문자, 줄바꿈 계열, 눈에 안 보이는 서식 문자(RTL 덮어쓰기, 제로폭, 한글 채움 문자 U+115F/1160/3164/FFA0,
// 점자 빈칸 U+2800, 아랍 문자 표시 U+061C, 결합 문자 연결 U+034F, 몽골 문자 구분자, 크메르 모음 U+17B4/17B5 등)
const NICKNAME_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u2800\u3164\uffa0\ufeff]/g;
// 변형 선택자(U+FE00-FE0F)와 태그 문자(U+E0000-E0FFF)는 이모지 표시에 쓰여서 지우지 않는다.
// 다만 이것들과 공백만 남았다면 화면에 보이는 글자가 없는 닉네임이다.
const NICKNAME_NO_VISIBLE_RE = /^[\s\ufe00-\ufe0f\u{e0000}-\u{e0fff}]*$/u;
// 시트가 수식으로 해석하는 시작 문자. 탭/CR 은 위에서 이미 제거되지만 방어적으로 한 번 더 막는다.
const FORMULA_START_RE = /^[=+\-@\t\r]/;

// ── 엔드포인트 ───────────────────────────────────────

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    // action 이 없거나 빈 문자열이면 게임 화면. action 이 있으면 (화면이 아닌 외부 클라이언트를 위한) JSON API 이다.
    if (p.action == null || p.action === '') return page_();
    if (String(p.action) !== 'ranking') return json_(fail_('bad_request'));
    return json_(rankingResult_(p.limit));
  } catch (err) {
    return internalError_(err);
  }
}

function doPost(e) {
  try {
    return json_(submitRaw_(e && e.postData && e.postData.contents));
  } catch (err) {
    return internalError_(err);
  }
}

// ── google.script.run 으로 부르는 공개 함수 ───────────────
// 이름이 밑줄(_)로 끝나면 google.script.run 이 부를 수 없다. 게임 화면이 불러야 하므로 이 둘은 일부러 밑줄이 없다.
// 결과는 doGet/doPost 의 JSON 과 같은 { ok, ... } 객체이고 절대 throw 하지 않는다 (실패는 { ok: false, error }).
// 검증, 빈도 제한, 재전송 판별, 락, 캐시는 HTTP 경로와 같은 코드를 쓴다.

function apiRanking(limit) {
  try {
    return rankingResult_(limit);
  } catch (err) {
    return internalErrorResult_(err);
  }
}

function apiSubmit(payload) {
  try {
    // doPost 가 받는 JSON 본문과 똑같은 모양/크기로 맞춰서 같은 길로 보낸다 (undefined, 함수, Date 등은 JSON 이 걸러낸다).
    let raw = null;
    try {
      raw = JSON.stringify(payload);
    } catch (err) {
      raw = null; // 순환 참조, BigInt 등
    }
    return submitRaw_(raw);
  } catch (err) {
    return internalErrorResult_(err);
  }
}

// ── 게임 화면 ────────────────────────────────────────

// Index 파일은 템플릿이 아니라 그대로 내보낸다 (createTemplateFromFile/스크립틀릿 <? ?> 을 쓰지 않는다).
// 파일이 없거나 읽을 수 없으면 스택 트레이스 없이 무엇을 해야 하는지만 알려 준다.
function page_() {
  try {
    return HtmlService.createHtmlOutputFromFile(PAGE_FILE).setTitle(PAGE_TITLE).addMetaTag('viewport', PAGE_VIEWPORT);
  } catch (err) {
    console.error(String((err && err.stack) || err));
    return ContentService.createTextOutput(PAGE_MISSING_MESSAGE);
  }
}

// ── 점수 제출 ────────────────────────────────────────

// 요청 본문(JSON 문자열)을 검사하고 점수를 제출한다. doPost 와 apiSubmit 이 함께 쓴다.
function submitRaw_(raw) {
  let body;
  try {
    if (typeof raw !== 'string' || !raw || raw.length > MAX_BODY_CHARS) return fail_('bad_request');
    body = JSON.parse(raw);
  } catch (err) {
    return fail_('bad_request');
  }
  return submitResult_(body);
}

function submitResult_(body) {
  try {
    return submitScore_(body);
  } catch (err) {
    return internalErrorResult_(err);
  }
}

function rankingResult_(limit) {
  try {
    return { ok: true, data: getRanking_().slice(0, parseLimit_(limit)) };
  } catch (err) {
    return internalErrorResult_(err);
  }
}

function submitScore_(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return fail_('bad_request');

  const nickname = sanitizeNickname_(b.nickname);
  if (!nickname) return fail_('invalid_nickname');

  const score = toInt_(b.score);
  if (score === null || score < 0 || score > MAX_SCORE) return fail_('invalid_score');

  const maxLevel = toInt_(b.maxLevel);
  const drops = toInt_(b.drops);
  const playTimeMs = toInt_(b.playTimeMs);
  if (maxLevel === null || maxLevel < 0 || maxLevel > MAX_LEVEL) return fail_('bad_request');
  if (drops === null || drops < 1 || drops > MAX_DROPS) return fail_('bad_request');
  if (playTimeMs === null || playTimeMs < 1 || playTimeMs > MAX_PLAY_TIME_MS) return fail_('bad_request');

  let clientId = '';
  if (b.clientId != null) {
    if (typeof b.clientId !== 'string' || !CLIENT_ID_RE.test(b.clientId)) return fail_('bad_request');
    clientId = b.clientId;
  }

  if (!isPlausible_(score, drops, playTimeMs)) return fail_('implausible');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return fail_('server_busy');
  try {
    // 확인과 기록을 같은 락 안에서 해야 같은 clientId 의 동시 요청이 둘 다 통과하지 못한다.
    const sheet = sheet_();
    // 응답이 유실돼(타임아웃/네트워크 끊김) 클라이언트가 같은 판을 다시 보내면, 이미 기록된 것이므로 성공으로 답한다.
    // 서버는 첫 요청을 이미 처리했을 수 있어서 이 확인이 없으면 같은 기록이 두 줄 쌓이고,
    // 빈도 제한이 "저장됐는데 너무 자주 등록한다"는 거짓 오류를 돌려준다. 그래서 빈도 제한보다 먼저 본다.
    if (clientId && isResubmission_(sheet, clientId, score, maxLevel, playTimeMs, drops)) return { ok: true };
    if (clientId && cacheGet_(THROTTLE_KEY_PREFIX + clientId)) return fail_('throttled');
    ensureNicknameText_(sheet);
    sheet.appendRow([new Date(), nickname, score, maxLevel, playTimeMs, drops, clientId]);
    // 락을 풀기 전에 대기 중인 쓰기를 확정한다 (Lock 공식 문서의 권장). 이게 없으면 락을 이어받은 다른 실행(타임아웃 뒤 재시도 등)이
    // 방금 쓴 줄을 못 보고 isResubmission_ 이 놓치거나, 아래에서 비운 랭킹 캐시를 낡은 시트로 다시 채울 수 있다.
    SpreadsheetApp.flush();
    if (clientId) cachePut_(THROTTLE_KEY_PREFIX + clientId, '1', THROTTLE_SEC);
    cacheRemove_(RANKING_CACHE_KEY);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

// 같은 clientId 가 같은 판(점수, 최고 단계, 플레이 시간, 드롭 수가 모두 같음)을 이미 기록했는가.
// 플레이 시간이 밀리초 단위라 서로 다른 두 판이 모두 같을 수는 없다. 캐시가 아니라 시트를 보므로 며칠 뒤의 재전송도 잡힌다.
function isResubmission_(sheet, clientId, score, maxLevel, playTimeMs, drops) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const first = Math.max(2, last - RESUBMIT_SCAN_ROWS + 1);
  const values = sheet.getRange(first, 3, last - first + 1, 5).getValues(); // C..G: score, maxLevel, playTimeMs, drops, clientId
  for (let i = values.length - 1; i >= 0; i--) {
    const r = values[i];
    if (
      String(r[4]) === clientId &&
      toInt_(r[0]) === score &&
      toInt_(r[1]) === maxLevel &&
      toInt_(r[2]) === playTimeMs &&
      toInt_(r[3]) === drops
    ) {
      return true;
    }
  }
  return false;
}

// 닉네임 열을 일반 텍스트로 고정한다. 자동 서식이면 "3-4", "1/2", "12:30", "TRUE", "007" 이 날짜/불리언/숫자로 바뀌어
// 닉네임이 달라지거나 랭킹에서 사라진다. setup() 을 건너뛴 수동 배포도 첫 제출 때 고쳐지도록 여기서도 한 번 적용한다.
// 서식 지정 실패가 제출을 막아서는 안 된다.
function ensureNicknameText_(sheet) {
  try {
    const props = PropertiesService.getScriptProperties();
    const id = props.getProperty(PROP_SHEET_ID);
    if (props.getProperty(PROP_NICKNAME_TEXT) === id) return;
    sheet.getRange('B:B').setNumberFormat('@');
    props.setProperty(PROP_NICKNAME_TEXT, id);
  } catch (err) {
    console.error(String((err && err.stack) || err));
  }
}

function isPlausible_(score, drops, playTimeMs) {
  if (playTimeMs < (drops - 1) * MIN_MS_PER_DROP) return false;
  return score <= drops * MAX_SCORE_PER_DROP;
}

function sanitizeNickname_(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(NICKNAME_STRIP_RE, '').trim();
  s = Array.from(s).slice(0, MAX_NICKNAME).join('').trim(); // 코드포인트 단위로 자른다 (이모지 보호)
  if (NICKNAME_NO_VISIBLE_RE.test(s)) return '';
  if (FORMULA_START_RE.test(s)) s = "'" + s; // 시트 수식 인젝션 방지
  return s;
}

// ── 랭킹 ─────────────────────────────────────────────

function getRanking_() {
  const hit = cacheGet_(RANKING_CACHE_KEY);
  if (hit) {
    try {
      const cached = JSON.parse(hit);
      if (Array.isArray(cached)) return cached;
    } catch (err) {
      // 깨진 캐시는 미스로 취급하고 시트에서 다시 만든다
    }
  }
  const rows = readScores_();
  cachePut_(RANKING_CACHE_KEY, JSON.stringify(rows), RANKING_CACHE_SEC);
  return rows;
}

function readScores_() {
  const sheet = sheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, SHEET_HEADERS.length).getValues(); // 헤더 제외

  // 닉네임 열이 일반 텍스트가 되기 전에 쌓인 행은 날짜/불리언 셀일 수 있다. 그때만 시트에 보이는 문자열을 읽는다.
  let display = null;
  const displayNickname = (i) => {
    if (!display) display = sheet.getRange(2, 2, last - 1, 1).getDisplayValues();
    return display[i][0];
  };

  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const row = parseRow_(values[i], i, displayNickname);
    if (row) rows.push(row);
  }
  // 점수 내림차순, 같으면 먼저 기록한 쪽이 위
  rows.sort((a, b) => b.score - a.score || a.at - b.at || a.index - b.index);
  return rows.slice(0, RANKING_KEEP).map((r) => ({
    nickname: r.nickname,
    score: r.score,
    maxLevel: r.maxLevel,
    at: r.at,
  }));
}

// 손으로 편집했거나 깨진 행은 null 을 돌려 건너뛴다.
function parseRow_(r, index, displayNickname) {
  const at = toTime_(r[0]);
  let nickname = rankingNickname_(r[1]);
  if (!nickname && displayNickname && (isDate_(r[1]) || typeof r[1] === 'boolean')) {
    nickname = rankingNickname_(displayNickname(index)); // 원래 글자는 잃었어도 행(점수)을 버리지는 않는다
  }
  const score = toInt_(r[2]);
  const maxLevel = toInt_(r[3]);
  if (at === null || !nickname) return null;
  if (score === null || score < 0 || score > MAX_SCORE) return null;
  if (maxLevel === null || maxLevel < 0 || maxLevel > MAX_LEVEL) return null;
  return { index, at, nickname, score, maxLevel };
}

// 시트는 "1234" 같은 닉네임을 숫자 셀로 바꿀 수 있어 숫자도 받는다.
function rankingNickname_(v) {
  const s = typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : '';
  // 시트에 글자 그대로 남은 인젝션 방지용 접두 따옴표를 표시용으로 벗긴다 ("-_-" 같은 닉네임 복원)
  const t = s.replace(NICKNAME_STRIP_RE, '').trim().replace(/^'(?=[=+\-@])/, '');
  return NICKNAME_NO_VISIBLE_RE.test(t) ? '' : t;
}

function parseLimit_(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return DEFAULT_LIMIT; // google.script.run 은 아무 값이나 넘길 수 있다
  if (raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (isNaN(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(n), 1), RANKING_KEEP);
}

// ── 설정 (편집기에서 수동 1회 실행) ─────────────────────

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('setup() 은 스프레드시트에서 연 Apps Script(확장 프로그램 → Apps Script)에서만 실행할 수 있습니다.');
  }
  PropertiesService.getScriptProperties().setProperty(PROP_SHEET_ID, ss.getId());

  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  const width = SHEET_HEADERS.length;
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, width).setValues([SHEET_HEADERS]);
  } else {
    const first = sheet.getRange(1, 1, 1, width).getValues()[0];
    if (!SHEET_HEADERS.every((h, i) => first[i] === h)) {
      // 예전 6열 헤더면 그 줄을 고치고, 헤더가 아예 없으면 데이터를 건드리지 않게 윗줄을 끼운다
      if (String(first[0]).trim().toLowerCase() !== 'timestamp') sheet.insertRowBefore(1);
      sheet.getRange(1, 1, 1, width).setValues([SHEET_HEADERS]);
    }
  }
  sheet.setFrozenRows(1);
  // 닉네임 열은 일반 텍스트로 둔다. 안 그러면 "007"이 7로, "3-4"가 날짜로 바뀐다.
  sheet.getRange('B:B').setNumberFormat('@');
  PropertiesService.getScriptProperties().setProperty(PROP_NICKNAME_TEXT, ss.getId());

  console.log('SHEET_ID 저장 완료: ' + ss.getId() + ' (시트 "' + SHEET_NAME + '" 준비됨)');
  console.log(
    '다음 단계: (1) 배포 → 새 배포 → 유형 "웹 앱", 실행 사용자 "나", 액세스 "모든 사용자" ' +
      '(2) 발급된 …/exec 주소를 열면 게임이 나온다 (이 주소만 알려 주면 된다) ' +
      '(3) 코드나 Index.html 을 고친 뒤에는 배포 관리 → 편집 → 새 버전으로 같은 주소를 유지 ' +
      '(js/config.js 의 API_URL 은 게임 화면을 GitHub Pages 처럼 다른 곳에 올릴 때만 필요하다)'
  );
}

// ── 유틸 ─────────────────────────────────────────────

function sheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(PROP_SHEET_ID);
  if (!id) throw new Error('SHEET_ID 가 없습니다. setup() 을 먼저 실행하세요.');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('"' + SHEET_NAME + '" 시트가 없습니다. setup() 을 실행하세요.');
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(error) {
  return { ok: false, error };
}

// 응답에는 상세를 싣지 않고 실행 로그에만 남긴다.
function internalErrorResult_(err) {
  console.error(String((err && err.stack) || err));
  return fail_('server_busy');
}

function internalError_(err) {
  return json_(internalErrorResult_(err));
}

// 정수만 허용한다. 숫자 또는 숫자 문자열만 받고 true/null/[] 같은 값은 Number() 변환에 기대지 않고 거른다.
function toInt_(v) {
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^-?\d{1,15}$/.test(v)) n = Number(v);
  if (n === null || !Number.isSafeInteger(n)) return null;
  return n === 0 ? 0 : n; // -0 정규화
}

// 컨텍스트가 다른 Date 도 인식하도록 toString 으로 판별한다.
function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function toTime_(v) {
  let t = NaN;
  if (isDate_(v)) t = v.getTime();
  else if (typeof v === 'number') t = v;
  else if (typeof v === 'string' && v.trim()) t = new Date(v).getTime();
  return isFinite(t) ? t : null;
}

function cacheGet_(key) {
  try {
    return CacheService.getScriptCache().get(key);
  } catch (err) {
    return null;
  }
}

function cachePut_(key, value, sec) {
  try {
    CacheService.getScriptCache().put(key, value, sec);
  } catch (err) {
    // 캐시는 최적화일 뿐이다
  }
}

function cacheRemove_(key) {
  try {
    CacheService.getScriptCache().remove(key);
  } catch (err) {
    // 실패해도 캐시 TTL(60초) 안에 갱신된다
  }
}
