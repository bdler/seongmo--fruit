/**
 * 수박 합치기 — 랭킹 백엔드 (Google Apps Script 웹 앱, 스프레드시트에 바인딩된 스크립트)
 *
 *   GET  ?action=ranking&limit=10  -> { ok: true, data: [{ nickname, score, maxLevel, at }] }
 *   POST text/plain JSON 본문       -> { ok: true } | { ok: false, error: '<코드>' }
 *
 * 에러 코드: bad_request, invalid_nickname, invalid_score, implausible, throttled, server_busy
 * (서버 내부 오류는 상세를 숨기고 server_busy 로 응답한다. 원인은 실행 로그에만 남는다.)
 *
 * 처음 한 번: 편집기에서 setup() 을 실행한 뒤 웹 앱으로 배포한다.
 */

const SHEET_NAME = 'scores';
const SHEET_HEADERS = ['timestamp', 'nickname', 'score', 'maxLevel', 'playTimeMs', 'drops', 'clientId'];
const PROP_SHEET_ID = 'SHEET_ID';

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

const THROTTLE_SEC = 10;
const THROTTLE_KEY_PREFIX = 'thr:';
const LOCK_WAIT_MS = 5000;

const RANKING_CACHE_KEY = 'ranking';
const RANKING_CACHE_SEC = 60;
const RANKING_KEEP = 50;
const DEFAULT_LIMIT = 10;

// 제어문자, 줄바꿈 계열, 눈에 안 보이는 서식 문자(RTL 덮어쓰기, 제로폭, 한글 채움 문자 등)
const NICKNAME_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\u3164\uffa0\ufeff]/g;
// 시트가 수식으로 해석하는 시작 문자. 탭/CR 은 위에서 이미 제거되지만 방어적으로 한 번 더 막는다.
const FORMULA_START_RE = /^[=+\-@\t\r]/;

// ── 엔드포인트 ───────────────────────────────────────

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = p.action == null || p.action === '' ? 'ranking' : String(p.action);
    if (action !== 'ranking') return json_({ ok: false, error: 'bad_request' });
    return json_({ ok: true, data: getRanking_().slice(0, parseLimit_(p.limit)) });
  } catch (err) {
    return internalError_(err);
  }
}

function doPost(e) {
  let body;
  try {
    const raw = e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || !raw || raw.length > MAX_BODY_CHARS) {
      return json_({ ok: false, error: 'bad_request' });
    }
    body = JSON.parse(raw);
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  try {
    return json_(submitScore_(body));
  } catch (err) {
    return internalError_(err);
  }
}

// ── 점수 제출 ────────────────────────────────────────

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
    if (clientId && cacheGet_(THROTTLE_KEY_PREFIX + clientId)) return fail_('throttled');
    sheet_().appendRow([new Date(), nickname, score, maxLevel, playTimeMs, drops, clientId]);
    if (clientId) cachePut_(THROTTLE_KEY_PREFIX + clientId, '1', THROTTLE_SEC);
    cacheRemove_(RANKING_CACHE_KEY);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function isPlausible_(score, drops, playTimeMs) {
  if (playTimeMs < (drops - 1) * MIN_MS_PER_DROP) return false;
  return score <= drops * MAX_SCORE_PER_DROP;
}

function sanitizeNickname_(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(NICKNAME_STRIP_RE, '').trim();
  s = Array.from(s).slice(0, MAX_NICKNAME).join('').trim(); // 코드포인트 단위로 자른다 (이모지 보호)
  if (!s) return '';
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

  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const row = parseRow_(values[i], i);
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
function parseRow_(r, index) {
  const at = toTime_(r[0]);
  const nickname = rankingNickname_(r[1]);
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
  return s.replace(NICKNAME_STRIP_RE, '').trim().replace(/^'(?=[=+\-@])/, '');
}

function parseLimit_(raw) {
  if (raw == null || raw === '') return DEFAULT_LIMIT;
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

  console.log('SHEET_ID 저장 완료: ' + ss.getId() + ' (시트 "' + SHEET_NAME + '" 준비됨)');
  console.log(
    '다음 단계: (1) 배포 → 새 배포 → 유형 "웹 앱", 실행 사용자 "나", 액세스 "모든 사용자" ' +
      '(2) 발급된 …/exec URL 을 js/config.js 의 API_URL 에 입력 ' +
      '(3) 코드를 고친 뒤에는 배포 관리 → 편집 → 새 버전으로 같은 URL 을 유지'
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
function internalError_(err) {
  console.error(String((err && err.stack) || err));
  return json_({ ok: false, error: 'server_busy' });
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
function toTime_(v) {
  let t = NaN;
  if (Object.prototype.toString.call(v) === '[object Date]') t = v.getTime();
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
