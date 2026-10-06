// Apps Script(Code.gs) 를 Node 에서 돌리기 위한 모의 서비스와 vm 로더. 의존성이 없다 (node:vm, node:fs 만 쓴다).
//
// 사용 예
//   import { loadGas, createScriptRun, publicFunctions } from './helpers/gas-env.mjs';
//   const { gas, mocks } = loadGas({ files: { Index: '<!doctype html>…' }, rows: [HEADER, …] });
//   const page = gas.doGet({ parameter: {} });                   // HtmlOutput 모의: getContent() / getTitle() / getMetaTags()
//   const ranking = JSON.parse(gas.doGet({ parameter: { action: 'ranking' } }).getContent());
//   const result = gas.apiSubmit({ nickname: '…', score: 1, … });  // 평범한 { ok, … } 객체 (vm 의 객체이므로 비교 전에 JSON 을 한 번 거친다)
//   const { run } = createScriptRun(publicFunctions(gas));        // 브라우저의 google.script.run 대용 (아래 설명)
//
// loadGas(options) -> { gas, mocks }
//   options.files   { 이름: HTML 문자열 }  HtmlService.createHtmlOutputFromFile 이 읽는 파일. 이름은 확장자 없이 쓴다
//                   ('Index' 또는 'Index.html' 로 적어도 되지만 조회는 항상 'Index' 로만 된다).
//   options.rows    시트의 초기 행들 (기본: 헤더만). options.hasSheet=false 면 "scores" 시트가 없는 상태.
//   options.sheetId 스크립트 속성 SHEET_ID 의 값 (기본 SHEET_ID). null 이면 setup() 을 안 한 상태.
//   options.source  Code.gs 대신 올릴 소스 문자열 (기본: gas/Code.gs).
//   options.deferCommit  true 면 appendRow 가 SpreadsheetApp.flush() 나 mocks.endExecution() 전까지 '다른 실행'에게 보이지 않는다
//                   (아래 "쓰기 확정" 참고). 기본 false: appendRow 가 즉시 보인다.
//   gas     Code.gs 가 내보낸 함수들: doGet, doPost, setup, apiRanking, apiSubmit, page_, submitScore_, sanitizeNickname_,
//           isPlausible_, getRanking_ (없는 것은 undefined), consts(상수 모음),
//           functions(최상위 function 선언 전부: 이름 -> 함수, 밑줄 함수 포함), declaredFunctions(그 이름들, 정렬됨).
//   mocks   모의 서비스의 상태. 시계(now), 스크립트 속성(props), 캐시(cache/cachePuts/cacheRemoves), 락(lockWaits/lockHeld/lockFails/releases),
//           로그(logs/errors), 시트(sheet.rows/appendError/formatError/displayOf …), activeSpreadsheet, spreadsheet, openedIds,
//           html { files, requested: 요청된 파일 이름들, outputs: 만들어 준 HtmlOutput 들 },
//           events(서비스 호출 순서: 'tryLock' 'appendRow' 'flush' 'cachePut:키' 'cacheRemove:키' 'releaseLock'), flushes(flush 횟수),
//           flushError(설정하면 flush 가 던진다), execution/runAs/endExecution/onReleaseLock(아래 "쓰기 확정").
//
// 쓰기 확정 (SpreadsheetApp.flush) 모의
//   공식 Lock 문서: 스프레드시트를 다루는 락 안에서는 releaseLock() 전에 SpreadsheetApp.flush() 로 대기 중인 변경을 확정해야 한다.
//   deferCommit 이면 appendRow 한 줄은 쓴 실행(mocks.execution)에게만 보이고, flush() 나 mocks.endExecution() 때 모두에게 보인다.
//   mocks.runAs(이름, fn) 은 fn 을 '다른 실행'으로 돌리고, mocks.onReleaseLock 이 있으면 releaseLock() 직후에 부른다 (락을 이어받은 실행 흉내).
//   실제 플랫폼의 확정 시점은 확인하지 못한 가정이다. deferCommit 의 대상은 appendRow 뿐이다 (제출 경로의 유일한 쓰기).
//
// 어디까지 흉내 내는가 (그 밖은 일부러 없다 → Code.gs 가 쓰면 TypeError 로 드러난다)
//   SpreadsheetApp(openById/getActiveSpreadsheet/flush), PropertiesService, LockService, CacheService(만료 포함), ContentService(createTextOutput 만),
//   HtmlService(createHtmlOutputFromFile 만: 템플릿/스크립틀릿을 평가하지 않고 파일 내용을 그대로 돌려준다.
//   createTemplateFromFile/createHtmlOutput 은 없다), console.
//   HtmlService 모의: 없는 파일은 Error('Unknown file: 이름') 을 던진다 (정확한 문구는 Apps Script 의 것과 다를 수 있다).
//   Date 는 mocks.now 를 따르는 가짜 Date 로 바뀐다.
//
// createScriptRun(serverFns, { delayMs }) -> { run, calls }
//   브라우저의 google.script.run 흉내. serverFns 는 이름 -> 함수. 이름이 밑줄(_)로 끝나는 함수는 호출할 수 없다(실제 규칙).
//   - withSuccessHandler / withFailureHandler / withUserObject 는 호출마다 '새' 실행기를 돌려주고 원래 실행기는 바뀌지 않는다.
//   - 서버 함수 호출은 비동기다(기본 setTimeout 0). 인자와 결과는 JSON 으로 표현되는 값이어야 한다:
//     undefined/함수/Date/클래스 인스턴스가 들어 있으면 인자는 호출 즉시 throw, 결과는 failure 핸들러로 간다. 그렇지 않으면 JSON 복사본이 전달된다.
//   - 서버 함수가 throw 하면 failure 핸들러가 Error 를 받는다. 핸들러가 없으면 아무 일도 없다.
//   - delayMs 는 숫자 또는 (이름, 인자) => 숫자. Infinity 면 영영 답하지 않는다.
//   - calls 는 호출 기록 [{ fn, args, outcome }] (outcome: null | 'success' | 'failure'). 늦게 도착한 응답도 기록된다.
//   실제 Apps Script 와의 차이(미검증 가정): 존재하지 않는 서버 함수 이름은 여기서는 undefined 라서 호출하면 TypeError 이다.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const SHEET_ID = 'sheet-id-0001';
export const HEADER = ['timestamp', 'nickname', 'score', 'maxLevel', 'playTimeMs', 'drops', 'clientId'];
export const CODE_GS_URL = new URL('../../gas/Code.gs', import.meta.url);

const FN_NAMES = ['doGet', 'doPost', 'setup', 'apiRanking', 'apiSubmit', 'page_', 'submitScore_', 'sanitizeNickname_', 'isPlausible_', 'getRanking_'];
const CONST_NAMES = [
  'MAX_SCORE', 'MAX_SCORE_PER_DROP', 'MIN_MS_PER_DROP', 'RANKING_KEEP', 'RANKING_CACHE_SEC', 'THROTTLE_SEC', 'MAX_NICKNAME',
  'MAX_BODY_CHARS', 'PAGE_FILE', 'PAGE_TITLE', 'PAGE_VIEWPORT', 'PAGE_MISSING_MESSAGE',
];

// ── 시트 ────────────────────────────────────────────────

// rows 는 확정된 줄들. ctx(mocks)가 있으면 deferCommit 의 확정 대기 줄을 현재 실행(ctx.execution)에게만 보여 준다.
export function createSheet(rows, ctx = null) {
  const view = () => (sheet.pending.length ? [...sheet.rows, ...sheet.pending.filter((p) => p.owner === ctx?.execution).map((p) => p.values)] : sheet.rows);
  const sheet = {
    rows,
    pending: [], // deferCommit: [{ owner, values }] 아직 확정되지 않은 appendRow 들
    frozenRows: 0,
    numberFormats: [],
    reads: 0,
    getLastRow: () => view().length,
    commit(owner) {
      const mine = sheet.pending.filter((p) => p.owner === owner);
      sheet.pending = sheet.pending.filter((p) => p.owner !== owner);
      for (const p of mine) sheet.rows.push(p.values);
    },
    getRange(row, col, numRows, numCols) {
      // A1 표기('B:B')는 서식 지정에만 쓴다
      if (typeof row === 'string') {
        return {
          setNumberFormat(f) {
            if (sheet.formatError) throw sheet.formatError;
            sheet.numberFormats.push([row, f]);
          },
        };
      }
      return {
        // 화면에 보이는 문자열. 날짜/불리언 셀은 sheet.displayOf(값) 로 흉내 낸다 (기본은 String(값)).
        getDisplayValues() {
          return this.getValues().map((line) => line.map((v) => (sheet.displayOf ? sheet.displayOf(v) : String(v))));
        },
        getValues() {
          sheet.reads++;
          const out = [];
          const all = view();
          for (let r = 0; r < numRows; r++) {
            const line = all[row - 1 + r] || [];
            out.push(Array.from({ length: numCols }, (_, c) => (line[col - 1 + c] === undefined ? '' : line[col - 1 + c])));
          }
          return out;
        },
        setValues(values) {
          for (let r = 0; r < numRows; r++) {
            const line = sheet.rows[row - 1 + r] || (sheet.rows[row - 1 + r] = []);
            for (let c = 0; c < numCols; c++) line[col - 1 + c] = values[r][c];
          }
        },
      };
    },
    appendRow(values) {
      ctx?.events.push('appendRow');
      if (sheet.appendError) throw sheet.appendError;
      if (ctx?.deferCommit) sheet.pending.push({ owner: ctx.execution, values: Array.from(values) });
      else sheet.rows.push(Array.from(values));
    },
    insertRowBefore: (n) => void sheet.rows.splice(n - 1, 0, []),
    setFrozenRows: (n) => void (sheet.frozenRows = n),
  };
  return sheet;
}

// ── HtmlService ─────────────────────────────────────────

class HtmlOutputMock {
  constructor(name, content) {
    this.fileName = name;
    this.content = content;
    this.title = '';
    this.metaTags = [];
    this.xFrameOptionsMode = null;
  }
  setTitle(title) {
    if (typeof title !== 'string') throw new Error('setTitle: 문자열이 필요합니다');
    this.title = title;
    return this;
  }
  addMetaTag(name, content) {
    if (typeof name !== 'string' || typeof content !== 'string') throw new Error('addMetaTag: 문자열 두 개가 필요합니다');
    this.metaTags.push({ name, content });
    return this;
  }
  setXFrameOptionsMode(mode) {
    this.xFrameOptionsMode = mode;
    return this;
  }
  getContent() {
    return this.content;
  }
  getTitle() {
    return this.title;
  }
  getMetaTags() {
    return this.metaTags.map(({ name, content }) => ({ name, content, getName: () => name, getContent: () => content }));
  }
}

function createHtmlService(html) {
  return {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    createHtmlOutputFromFile(name) {
      html.requested.push(name);
      if (typeof name !== 'string' || !html.files.has(name)) throw new Error('Unknown file: ' + name);
      const out = new HtmlOutputMock(name, html.files.get(name));
      html.outputs.push(out);
      return out;
    },
  };
}

// ── Code.gs 로더 ────────────────────────────────────────

export function loadGas({ files = {}, rows, hasSheet = true, sheetId = SHEET_ID, source, deferCommit = false } = {}) {
  const src = source ?? readFileSync(CODE_GS_URL, 'utf8');
  const mocks = {
    now: Date.UTC(2026, 0, 1),
    props: new Map(sheetId ? [['SHEET_ID', sheetId]] : []),
    cache: new Map(),
    cachePuts: [],
    cacheRemoves: [],
    lockWaits: [],
    lockHeld: false,
    lockFails: false,
    releases: 0,
    events: [],
    flushes: 0,
    flushError: null,
    deferCommit,
    execution: 'main',
    onReleaseLock: null,
    logs: [],
    errors: [],
    openedIds: [],
    sheet: null,
    activeSpreadsheet: null,
    spreadsheet: null,
    html: {
      files: new Map(Object.entries(files).map(([name, content]) => [name.replace(/\.html$/i, ''), String(content)])),
      requested: [],
      outputs: [],
    },
  };

  if (hasSheet) mocks.sheet = createSheet(rows || [HEADER.slice()], mocks);
  mocks.runAs = (name, fn) => {
    const prev = mocks.execution;
    mocks.execution = name;
    try {
      return fn();
    } finally {
      mocks.execution = prev;
    }
  };
  mocks.endExecution = (name = mocks.execution) => mocks.sheet?.commit(name); // 실행이 끝나면 대기 중인 쓰기가 확정된다

  mocks.spreadsheet = {
    getId: () => SHEET_ID,
    getSheetByName: (name) => (name === 'scores' ? mocks.sheet : null),
    insertSheet(name) {
      if (name !== 'scores') throw new Error('예상 밖 시트 이름: ' + name);
      mocks.sheet = createSheet([], mocks);
      return mocks.sheet;
    },
  };

  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(mocks.now);
    }
    static now() {
      return mocks.now;
    }
  }

  const sandbox = {
    Date: FakeDate,
    console: {
      log: (...a) => void mocks.logs.push(a.join(' ')),
      error: (...a) => void mocks.errors.push(a.join(' ')),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (mocks.props.has(k) ? mocks.props.get(k) : null),
        setProperty: (k, v) => void mocks.props.set(k, String(v)),
      }),
    },
    SpreadsheetApp: {
      openById(id) {
        mocks.openedIds.push(id);
        if (id !== SHEET_ID) throw new Error('Unexpected error: Requested entity was not found. (id=' + id + ')');
        return mocks.spreadsheet;
      },
      getActiveSpreadsheet: () => mocks.activeSpreadsheet,
      flush() {
        mocks.events.push('flush');
        mocks.flushes++;
        if (mocks.flushError) throw mocks.flushError;
        mocks.sheet?.commit(mocks.execution);
      },
    },
    LockService: {
      getScriptLock: () => ({
        tryLock(ms) {
          mocks.events.push('tryLock');
          mocks.lockWaits.push(ms);
          if (mocks.lockFails) return false;
          mocks.lockHeld = true;
          return true;
        },
        releaseLock() {
          mocks.events.push('releaseLock');
          mocks.releases++;
          mocks.lockHeld = false;
          mocks.onReleaseLock?.();
        },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get(k) {
          const hit = mocks.cache.get(k);
          if (!hit) return null;
          if (mocks.now >= hit.expiresAt) {
            mocks.cache.delete(k);
            return null;
          }
          return hit.value;
        },
        put(k, v, sec) {
          mocks.events.push('cachePut:' + k);
          mocks.cachePuts.push({ key: k, sec });
          mocks.cache.set(k, { value: v, expiresAt: mocks.now + sec * 1000 });
        },
        remove(k) {
          mocks.events.push('cacheRemove:' + k);
          mocks.cacheRemoves.push(k);
          mocks.cache.delete(k);
        },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
      createTextOutput: (text) => ({
        text,
        mime: null,
        setMimeType(m) {
          this.mime = m;
          return this;
        },
        getContent() {
          return this.text;
        },
      }),
    },
    HtmlService: createHtmlService(mocks.html),
  };

  // 최상위 const 는 vm 컨텍스트의 속성이 되지 않으므로 같은 스크립트의 마지막 표현식으로 함께 돌려받는다.
  // (이름이 없으면 undefined 로 둔다)
  const pick = (name) => `${name}: (() => { try { return ${name}; } catch (e) { return undefined; } })()`;
  const code = `${src}
;({ ${FN_NAMES.map(pick).join(', ')}, consts: { ${CONST_NAMES.map(pick).join(', ')} } });`;
  const before = new Set(Object.keys(sandbox));
  const gas = vm.runInContext(code, vm.createContext(sandbox), { filename: 'Code.gs' });

  // 최상위 function 선언은 전역 속성이 된다. google.script.run 이 부를 수 있는 후보가 바로 이것들이다.
  const functions = {};
  for (const name of Object.keys(sandbox).filter((k) => !before.has(k) && typeof sandbox[k] === 'function').sort()) {
    functions[name] = sandbox[name];
  }
  gas.functions = functions;
  gas.declaredFunctions = Object.keys(functions);
  return { gas, mocks };
}

// google.script.run 으로 부를 수 있는 함수들: 이름이 밑줄로 끝나지 않는 최상위 함수 (이름 -> 함수)
export function publicFunctions(gas) {
  return Object.fromEntries(Object.entries(gas.functions).filter(([name]) => !name.endsWith('_')));
}

// ── google.script.run 모의 ───────────────────────────────

// google.script.run 이 받을 수 있는 값인가: null/문자열/숫자/불리언, 그리고 그것들로만 이루어진 배열과 평범한 객체.
function assertLegal(v, path) {
  if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertLegal(x, `${path}[${i}]`));
    return;
  }
  if (typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]') {
    const proto = Object.getPrototypeOf(v);
    if (proto === null || Object.getPrototypeOf(proto) === null) {
      for (const k of Object.keys(v)) assertLegal(v[k], `${path}.${k}`);
      return;
    }
  }
  throw new Error(`Failed due to illegal value in property: ${path}`);
}

const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

export function createScriptRun(serverFns, { delayMs = 0 } = {}) {
  const calls = [];
  const names = Object.keys(serverFns).filter((n) => !n.endsWith('_') && typeof serverFns[n] === 'function');

  function dispatch(state, name, args) {
    args.forEach((a, i) => assertLegal(a, String(i)));
    const entry = { fn: name, args: args.map(clone), outcome: null };
    calls.push(entry);
    const delay = typeof delayMs === 'function' ? delayMs(name, entry.args) : delayMs;
    if (delay === Infinity) return;
    setTimeout(async () => {
      let result;
      let failure = null;
      try {
        result = await serverFns[name](...entry.args.map(clone));
        assertLegal(result === undefined ? null : result, 'result');
        result = clone(result);
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      }
      entry.outcome = failure ? 'failure' : 'success';
      if (failure) state.failure?.(failure, state.userObject);
      else state.success?.(result, state.userObject);
    }, delay);
  }

  function make(state) {
    const runner = {
      withSuccessHandler: (fn) => make({ ...state, success: fn }),
      withFailureHandler: (fn) => make({ ...state, failure: fn }),
      withUserObject: (userObject) => make({ ...state, userObject }),
    };
    for (const name of names) runner[name] = (...args) => void dispatch(state, name, args);
    return runner;
  }

  return { run: make({}), calls };
}
