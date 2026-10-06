// scripts/build-gas.mjs 와 그 산출물(gas/Index.html)의 계약 검증.
// 브라우저 없이 문자열/구문 수준으로 확인한다 (실제 브라우저 동작은 e2e 에서).
//
// 실패 시 가장 흔한 원인: 원본(index.html, css, js/*.js)을 고치고 `npm run build:gas` 를 안 돌렸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BuildError,
  assembleHtml,
  assertSafeInline,
  buildGasHtml,
  bundleApp,
  headerComment,
  main,
  readMatter,
} from '../scripts/build-gas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPath = (...p) => path.join(ROOT, ...p);
const readText = (rel) => fs.readFileSync(rootPath(rel), 'utf8');

const OUT_REL = 'gas/Index.html';
const committed = fs.readFileSync(rootPath(OUT_REL)); // Buffer: 바이트 단위 비교용
const html = committed.toString('utf8');

// 크기 상한. 현재 약 172 KiB (176,199 bytes: Matter 80 KB + 앱 번들 72 KB + CSS 17 KB + HTML 4 KB).
// 이 값은 "실수로 부풀지 않았는지"를 보는 우리 쪽 안전선이지 Apps Script 의 공식 한도가 아니다
// (HtmlService 파일 크기 한도는 문서로 확인하지 못했다). 정당하게 커지면 근거를 적고 올린다.
const MAX_BYTES = 384 * 1024;

const U2028 = String.fromCharCode(0x2028);
const U2029 = String.fromCharCode(0x2029);

// ── 조각 추출 도우미 ──────────────────────────────────────
// 인라인 코드에는 `</script` / `</style` 가 없다는 것을 빌더가 보장하므로 정규식으로 안전하게 자를 수 있다.
function blocks(source, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'gi');
  return [...source.matchAll(re)].map((m) => ({ attrs: m[1].trim(), body: m[2], index: m.index }));
}
// 스크립트/스타일의 본문만 비운다 (여는 태그의 속성은 남겨서 src= 를 볼 수 있게. 빌더의 최종 방어선과 같은 방식)
const skeletonOf = (source) => source.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, '$1$3');
// src=/href= 속성 [이름, 값] 들. 값은 따옴표 없이 써도 잡는다.
const urlAttrsOf = (source) => [...source.matchAll(/\b(src|href)\s*=\s*(?:(["'])(.*?)\2|([^\s>]+))/gi)].map((m) => `${m[1]}=${m[3] ?? m[4]}`);
const scripts = blocks(html, 'script');
const styles = blocks(html, 'style');
const [matterBlock, appBlock] = scripts;

// 가짜 조각으로 assembleHtml 을 돌리기 위한 기본값 (실제 index.html 을 쓰되 나머지는 최소한)
const baseParts = () => ({
  indexHtml: readText('index.html'),
  css: 'body { margin: 0; }\n',
  matter: { version: '0.19.0', code: '/*! matter-js 0.19.0 */\nvar Matter = {};' },
  appJs: '"use strict";\n(() => {\n  var a = 1;\n})();',
});

// ── gas/ 폴더 ─────────────────────────────────────────────

// 운영체제가 폴더를 열면 저절로 만드는 파일. git(.gitignore)도 clasp(.gs/.js/.ts/.html 과 appsscript.json 만 올림)도 무시하므로 배포에 영향이 없다.
// 점 파일을 통째로 무시하면 안 된다: clasp 는 `.x.js` 같은 점 파일도 올린다.
const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const gasEntries = (dir) => fs.readdirSync(dir).filter((name) => !OS_JUNK.has(name)).sort();

test('gas/ 에는 Code.gs, Index.html, appsscript.json 세 파일만 있다 (clasp 이 그대로 올린다)', () => {
  assert.deepEqual(gasEntries(rootPath('gas')), ['Code.gs', 'Index.html', 'appsscript.json']);
});

test('gas/ 점검은 .DS_Store 같은 OS 잡파일은 무시하지만 올라갈 수 있는 낯선 파일(.x.js, notes.txt)은 잡아낸다', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'gas-entries-test-'));
  try {
    for (const name of ['Code.gs', 'Index.html', 'appsscript.json', '.DS_Store', 'Thumbs.db', 'desktop.ini']) fs.writeFileSync(path.join(dir, name), '');
    assert.deepEqual(gasEntries(dir), ['Code.gs', 'Index.html', 'appsscript.json']);
    for (const stray of ['.x.js', 'notes.txt']) {
      fs.writeFileSync(path.join(dir, stray), '');
      assert.ok(gasEntries(dir).includes(stray), stray);
      fs.rmSync(path.join(dir, stray));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 신선도 · 결정성 ───────────────────────────────────────

test('신선도: 커밋된 gas/Index.html 은 빌드 결과와 바이트까지 같다', () => {
  const built = Buffer.from(buildGasHtml({ root: ROOT }), 'utf8');
  if (!built.equals(committed)) {
    const a = committed.toString('utf8').split('\n');
    const b = built.toString('utf8').split('\n');
    let line = 0;
    while (line < Math.max(a.length, b.length) && a[line] === b[line]) line += 1;
    assert.fail(`gas/Index.html 이 오래됐습니다 (처음 다른 줄: ${line + 1}). \`npm run build:gas\` 를 실행하고 결과를 커밋하세요.`);
  }
});

test('결정성: 두 번 빌드하면 완전히 같다', () => {
  const a = buildGasHtml({ root: ROOT });
  const b = buildGasHtml({ root: ROOT });
  assert.equal(a, b);
});

test('형식: 머리말 주석(GENERATED/명령/수정 금지), LF, 끝 개행 하나, BOM 없음, 크기 상한', () => {
  const DOCTYPE = '<!doctype html>\n';
  assert.ok(html.startsWith(DOCTYPE), '파일은 주석이 아니라 doctype 으로 시작해야 함');
  assert.ok(html.startsWith(`${DOCTYPE}<!--\n`), 'doctype 바로 다음 줄이 머리말 주석');
  const header = html.slice(DOCTYPE.length, html.indexOf('-->') + 3);
  assert.match(header, /GENERATED/);
  assert.match(header, /DO NOT EDIT/i);
  assert.match(header, /npm run build:gas/);
  assert.ok(!header.slice(4, -3).includes('--'), '주석 본문에 "--" 가 있으면 안 됨');
  assert.equal(headerComment(), header + '\n', '머리말은 headerComment() 와 같아야 함');
  assert.ok(html.slice(DOCTYPE.length + header.length + 1).startsWith('<html'), '머리말 바로 다음이 <html>');
  assert.ok(!html.includes('\r'), 'CR 이 없어야 함 (LF 고정)');
  assert.ok(!html.startsWith('﻿'), 'BOM 이 없어야 함');
  assert.ok(html.endsWith('</html>\n') && !html.endsWith('\n\n'), '끝은 </html> + 개행 하나');
  assert.ok(committed.length < MAX_BYTES, `크기 ${committed.length} bytes 가 상한 ${MAX_BYTES} 를 넘음`);
  assert.ok(committed.length > 100 * 1024, `크기 ${committed.length} bytes: Matter + 앱이 모두 들어 있어야 함`);
});

// ── 구조 ──────────────────────────────────────────────────

test('<style> 은 정확히 1개이고 내용은 css/style.css 그대로, 외부 스타일시트 링크는 없다', () => {
  assert.equal(styles.length, 1);
  assert.equal(styles[0].attrs, '');
  assert.equal(styles[0].body, `\n${readText('css/style.css').replace(/\r\n/g, '\n').trimEnd()}\n`);
  assert.ok(!/<link\b[^>]*rel=["']?stylesheet/i.test(html));
});

test('인라인 <script> 는 정확히 2개(Matter, 앱): 둘 다 src/type 없는 클래식 스크립트', () => {
  assert.equal(scripts.length, 2);
  for (const s of scripts) assert.equal(s.attrs, '', `속성이 없어야 함: <script ${s.attrs}>`);
  assert.ok(!/type\s*=\s*["']?module/i.test(html), 'type=module 이 없어야 함');
  assert.ok(!/<script[^>]*\bsrc\s*=/i.test(html), 'src= 스크립트가 없어야 함');
});

test('각 인라인 스크립트는 클래식 스크립트로 구문 분석된다 (vm.Script)', () => {
  for (const [i, s] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(s.body, { filename: `inline-script-${i}.js` }), `script #${i}`);
  }
});

test('Matter 가 앱보다 먼저, 둘 다 </body> 앞 body 끝쪽에 있다', () => {
  assert.ok(matterBlock.index < appBlock.index);
  assert.ok(appBlock.index < html.indexOf('</body>'));
  assert.ok(html.indexOf('<body>') < matterBlock.index, '스크립트는 DOM(body 내용) 뒤에서 실행되도록 body 안에 있어야 함');
  assert.ok(html.indexOf('id="game-canvas"') < matterBlock.index, 'DOM 이 스크립트보다 먼저');
  assert.ok(html.indexOf('<noscript>') > 0);
});

test('Matter: node_modules 의 0.19.0 을 그대로 넣었고(소스맵 줄만 제거), 클래식 스크립트로 전역 Matter 를 만든다', () => {
  const { version, code } = readMatter({ root: ROOT });
  assert.equal(version, '0.19.0');
  assert.equal(matterBlock.body, `\n${code}\n`);
  assert.ok(!/sourceMappingURL/.test(html), 'sourceMappingURL 이 남아 있으면 안 됨');
  assert.match(matterBlock.body, /matter-js 0\.19\.0/);
  // 브라우저처럼 모듈 시스템이 없는 전역에서 실행 → 전역 Matter
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(matterBlock.body).runInContext(sandbox);
  assert.equal(typeof sandbox.Matter?.Engine, 'object');
  assert.equal(sandbox.Matter.version, '0.19.0');
});

test('앱 번들: strict 모드 IIFE, import/export/import.meta/최상위 await 가 없다', () => {
  const app = appBlock.body.trim();
  assert.ok(app.startsWith('"use strict";\n(() => {'), '"use strict" + IIFE 로 시작');
  assert.ok(app.endsWith('})();'), 'IIFE 로 끝');
  assert.ok(!/^\s*import\s/m.test(app), 'import 문');
  assert.ok(!/\bimport\s*\(/.test(app), '동적 import()');
  assert.ok(!/\bimport\.meta\b/.test(app), 'import.meta');
  assert.ok(!/^\s*export\s/m.test(app), 'export 문');
  // 최상위 await 는 클래식 스크립트에서 구문 오류이므로 위의 vm.Script 통과가 곧 증명이지만, 한 번 더 직접 확인한다.
  assert.throws(() => new vm.Script('await 1;'), SyntaxError);
  assert.doesNotThrow(() => new vm.Script(app));
  // 모든 모듈이 묶였다
  for (const f of ['config', 'game', 'physics', 'render', 'audio', 'input', 'storage', 'api', 'main']) {
    assert.ok(app.includes(`// js/${f}.js`), `js/${f}.js 가 번들에 있어야 함`);
  }
  // 설계 결정 8: ?debug 훅은 쿼리 플래그가 있을 때만 설치된다
  assert.match(app, /URLSearchParams\(location\.search\)\.has\(["']debug["']\)/);
});

test('원본 body 구조가 그대로다 (스크립트/스타일/주석/스타일시트 링크만 달라짐)', () => {
  const flat = (s) =>
    s
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<link rel="stylesheet"[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  assert.equal(flat(html), flat(readText('index.html')));
  const ids = (s) => [...skeletonOf(s).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids(html), ids(readText('index.html')));
  for (const id of ['game-canvas', 'screen-start', 'btn-start', 'ranking-list']) assert.ok(html.includes(`id="${id}"`), id);
  // 보존 대상
  assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'));
  assert.ok(html.includes('<title>수박 합치기</title>'));
  assert.ok(html.includes('<html lang="ko">'));
  assert.ok(html.includes('<noscript>이 게임은 JavaScript가 필요합니다.</noscript>'));
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,[^"]*🍉[^"]*">/);
});

test('한글/이모지가 \\u 이스케이프 없이 그대로 들어 있다', () => {
  for (const s of ['랭킹 불러오는 중…', '물리 엔진(Matter.js)을 불러오지 못했어요', '네트워크 연결을 확인하고 다시 시도해 주세요.', '게임 시작', '🏆 랭킹 보기', '🍉 수박 완성!']) {
    assert.ok(html.includes(s), `없음: ${s}`);
  }
  assert.ok(!/\\u(?:[ac-d][0-9a-f]{3})/i.test(html), '한글 음절이 \\u 로 이스케이프되면 안 됨');
  assert.ok(!html.includes(U2028) && !html.includes(U2029), '리터럴 U+2028/2029 가 없어야 함');
});

test('config 의 과일 이름/이모지가 번들에 그대로 들어 있다', async () => {
  const { FRUITS } = await import(pathToFileURL(rootPath('js/config.js')).href);
  assert.ok(FRUITS.length > 0);
  for (const f of FRUITS) {
    assert.ok(appBlock.body.includes(f.name), f.name);
    assert.ok(appBlock.body.includes(f.emoji), f.emoji);
  }
});

// ── 외부 자원 없음 ────────────────────────────────────────

test('src=/href= 속성은 data: URI 하나(favicon)뿐이고 ./js, ./css, http(s) 를 가리키는 것이 없다', () => {
  const attrs = urlAttrsOf(skeletonOf(html));
  assert.equal(attrs.length, 1, `속성: ${attrs.join(' | ')}`);
  assert.match(attrs[0], /^href=data:image\/svg\+xml,/);
  for (const bad of ['src="./', 'href="./', 'cdnjs', 'googleapis', 'gstatic']) assert.ok(!html.includes(bad), `"${bad}" 가 남아 있음`);
  assert.ok(!/@import|url\(\s*["']?(?!data:|#)/i.test(styles[0].body), 'CSS 에 외부 url()/@import 없음');
});

test('http(s):// 문자열은 정확히 두 곳뿐: Matter 머리말 주석의 홈페이지, favicon SVG 의 xmlns', async () => {
  const URL_RE = /https?:\/\/[^\s"'<>)]+/g;
  const urls = (s) => s.match(URL_RE) ?? [];
  const faviconTag = /<link rel="icon" href="data:[^"]*">/.exec(html)[0];
  assert.deepEqual(urls(faviconTag), ['http://www.w3.org/2000/svg'], 'favicon: SVG 네임스페이스 식별자일 뿐 요청이 아님');

  const matterHeader = /^\s*\/\*![\s\S]*?\*\//.exec(matterBlock.body)[0];
  assert.deepEqual(urls(matterHeader), ['http://brm.io/matter-js/'], 'Matter 머리말 주석(링크일 뿐)');
  assert.deepEqual(urls(matterBlock.body.replace(matterHeader, '')), [], 'Matter 코드 본문에는 URL 이 없어야 함');

  // 그 밖의 모든 곳(앱 번들, CSS, HTML)에는 없어야 한다. 단 config.API_URL 을 채웠다면 그 값은 앱 번들에 한해 허용(fetch 대체 경로).
  const { API_URL } = await import(pathToFileURL(rootPath('js/config.js')).href);
  const rest = html.replace(faviconTag, '').replace(matterBlock.body, '');
  const found = urls(rest).filter((u) => u !== API_URL);
  assert.deepEqual(found, [], '예상하지 못한 URL');
});

// ── 빌더: 표식(marker) 검사 ───────────────────────────────

const MARKERS = [
  ['css 링크', '<link rel="stylesheet" href="./css/style.css">'],
  ['Matter CDN 스크립트', '<script src="https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.19.0/matter.min.js"></script>'],
  ['앱 모듈 스크립트', '<script type="module" src="./js/main.js"></script>'],
];

test('조립 기본 경로는 성공한다 (이후 음성 테스트의 대조군)', () => {
  const out = assembleHtml(baseParts());
  assert.ok(out.includes('<style>\nbody { margin: 0; }\n</style>'));
  assert.ok(out.includes('var Matter = {};'));
});

for (const [name, marker] of MARKERS) {
  test(`표식 변조: ${name} 가 없으면 빌더가 던진다`, () => {
    const parts = baseParts();
    assert.ok(parts.indexHtml.includes(marker), '전제: 원본에 표식이 있음');
    parts.indexHtml = parts.indexHtml.replace(marker, marker.replace(/./, 'X'));
    assert.throws(() => assembleHtml(parts), (e) => e instanceof BuildError && /표식을 찾지 못했/.test(e.message));
  });
  test(`표식 변조: ${name} 가 두 번 있으면 빌더가 던진다`, () => {
    const parts = baseParts();
    parts.indexHtml = parts.indexHtml.replace(marker, `${marker}\n  ${marker}`);
    assert.throws(() => assembleHtml(parts), (e) => e instanceof BuildError && /두 번 이상/.test(e.message));
  });
}

test('표식 변조: doctype/head/body 구조가 어긋나면 던진다', () => {
  for (const mutate of [
    (h) => h.replace('<!doctype html>', '<html>'),
    (h) => h.replace('<body>', '<body class="x">'),
    (h) => h.replace('</head>', '</head></head>'),
  ]) {
    const parts = baseParts();
    parts.indexHtml = mutate(parts.indexHtml);
    assert.throws(() => assembleHtml(parts), BuildError);
  }
});

test('Matter 버전 불일치: CDN 표식의 버전과 node_modules 버전이 다르면 던진다', () => {
  const parts = baseParts();
  parts.matter = { version: '0.20.0', code: '/*! matter-js 0.20.0 */' };
  assert.throws(() => assembleHtml(parts), (e) => e instanceof BuildError && /Matter\.js CDN/.test(e.message));
});

// ── 빌더: 외부 자원 최종 방어선 ───────────────────────────
// index.html 에 외부 자원이 끼어들면 (직접 쓴 <script src>, 인라인 <style> 의 @import, 따옴표 없는 속성) 빌드가 실패해야 한다.
// 이 방어선이 죽어 있어도 커밋된 산출물 검사(위)가 나중에 잡지만, 그것은 사람이 다시 빌드해 본 뒤의 일이다.
const EXTERNAL_INJECTIONS = [
  ['외부 <script src>', '<script src="https://example.com/analytics.js"></script>', /example\.com\/analytics\.js/],
  ['따옴표 없는 외부 <script src>', '<script src=https://example.com/a.js></script>', /example\.com\/a\.js/],
  ['외부 <script src> + 속성(async)', '<script async src="//cdn.example.com/a.js"></script>', /cdn\.example\.com/],
  ['따옴표 없는 <link rel=stylesheet href>', '<link rel=stylesheet href=https://cdn.example.com/x.css>', /cdn\.example\.com\/x\.css/],
  ['따옴표 있는 <link rel=preconnect>', '<link rel="preconnect" href="https://fonts.googleapis.com">', /fonts\.googleapis\.com/],
  ['따옴표 없는 <img src>', '<img src=https://example.com/a.png alt="">', /example\.com\/a\.png/],
  ['상대 경로 <script src>', '<script src="./js/extra.js"></script>', /\.\/js\/extra\.js/],
];
for (const [name, tag, re] of EXTERNAL_INJECTIONS) {
  test(`외부 자원 방어선: ${name} 가 index.html 에 있으면 빌더가 던진다`, () => {
    const parts = baseParts();
    parts.indexHtml = parts.indexHtml.replace('<noscript>', () => `${tag}\n  <noscript>`);
    assert.ok(parts.indexHtml.includes(tag), '전제: 주입됨');
    assert.throws(() => assembleHtml(parts), (e) => e instanceof BuildError && /외부\/상대 자원 참조/.test(e.message) && re.test(e.message));
  });
}

test('외부 자원 방어선: 인라인 <style> 의 @import 와 외부 url() 도 던진다 (css/style.css 와 같은 기준)', () => {
  for (const style of ['@import url("https://fonts.googleapis.com/css2?family=Jua");', 'a { background: url(https://example.com/a.png); }']) {
    const parts = baseParts();
    parts.indexHtml = parts.indexHtml.replace('<noscript>', () => `<style>${style}</style>\n  <noscript>`);
    assert.throws(() => assembleHtml(parts), (e) => e instanceof BuildError && /인라인 <style>/.test(e.message), style);
  }
  const ok = baseParts();
  ok.indexHtml = ok.indexHtml.replace('<noscript>', () => '<style>a { background: url(data:image/png;base64,AAAA); } b { fill: url(#g); }</style>\n  <noscript>');
  assert.doesNotThrow(() => assembleHtml(ok));
});

test('외부 자원 방어선: 앱/Matter 본문 속의 문자열(src=, href= 처럼 보이는 것)은 속성이 아니므로 걸리지 않고, data: favicon 은 허용된다', () => {
  const parts = baseParts();
  parts.appJs = '"use strict";\n(() => { var a = \'<img src="https://example.com/x.png">\'; })();';
  parts.matter = { version: '0.19.0', code: '/*! matter-js 0.19.0 */\nvar Matter = { s: \'href=https://example.com\' };' };
  const out = assembleHtml(parts);
  assert.ok(out.includes('href="data:image/svg+xml,'), 'favicon 이 남아 있어야 함');
  assert.deepEqual(urlAttrsOf(skeletonOf(out)).filter((a) => !/^href=data:/.test(a)), []);
});

// ── 빌더: 위험 문자열 ─────────────────────────────────────

const HAZARD_CASES = [
  ['</script', 'var s = "</script>";'],
  ['</SCRIPT (대소문자)', 'var s = "</SCRIPT >";'],
  ['<!--', 'var s = "<!--";'],
  ['-->', 'var a = 1;\n--> comment-like'],
  ['<? 스크립틀릿', 'var s = "<?= x ?>";'],
  ['U+2028', `var s = "a${U2028}b";`],
  ['U+2029', `var s = "a${U2029}b";`],
];
for (const [name, code] of HAZARD_CASES) {
  for (const where of ['appJs', 'matter']) {
    test(`위험 문자열 거부: ${name} in ${where}`, () => {
      const parts = baseParts();
      if (where === 'appJs') parts.appJs = `(() => {\n${code}\n})();`;
      else parts.matter = { version: '0.19.0', code: `/*! matter-js 0.19.0 */\n${code}` };
      assert.throws(() => assembleHtml(parts), (e) => e instanceof BuildError && /위험한 문자열/.test(e.message));
    });
  }
}

test('위험 문자열 거부: CSS 의 </style, <!--, 외부 url(), @import', () => {
  for (const css of ['a::after { content: "</style>"; }', 'a { content: "<!--"; }', 'a { background: url(./x.png); }', 'a { background: url("https://e.x/a.png"); }', '@import "x.css";']) {
    const parts = baseParts();
    parts.css = css;
    assert.throws(() => assembleHtml(parts), BuildError, css);
  }
  const ok = baseParts();
  ok.css = 'a { background: url(data:image/png;base64,AAAA); } b { fill: url(#grad); }';
  assert.doesNotThrow(() => assembleHtml(ok));
});

test('assertSafeInline 은 줄 번호와 주변 문맥을 알려 준다', () => {
  assert.throws(() => assertSafeInline('앱', 'a\nb\nvar x = "</script>";'), /앱 3번째 줄 근처/);
});

test('`$&`, `$\'`, `$1` 같은 문자열이 들어 있어도 그대로 보존된다 (String.replace 의 특수 치환 회피)', () => {
  const parts = baseParts();
  parts.css = 'a::before { content: "$& $\' $1 $$ $`"; }';
  parts.appJs = '(() => { var t = "$& $\' $1 $$ $`"; })();';
  parts.matter = { version: '0.19.0', code: '/*! matter-js 0.19.0 */\nvar m = "$& $1";' };
  const out = assembleHtml(parts);
  assert.ok(out.includes(parts.css));
  assert.ok(out.includes(parts.appJs));
  assert.ok(out.includes('var m = "$& $1";'));
});

test('CRLF/BOM 입력도 LF 출력과 바이트까지 같다', () => {
  const lf = baseParts();
  const crlf = {
    indexHtml: `﻿${lf.indexHtml.replace(/\n/g, '\r\n')}`,
    css: lf.css.replace(/\n/g, '\r\n'),
    matter: { version: lf.matter.version, code: lf.matter.code.replace(/\n/g, '\r\n') },
    appJs: lf.appJs.replace(/\n/g, '\r\n'),
  };
  assert.equal(assembleHtml(crlf), assembleHtml(lf));
});

// ── 빌더: 번들/Matter 읽기 ────────────────────────────────

function makeFixture({ main = 'document.title = "x";\n', matterVersion = '0.19.0', matterCode } = {}) {
  const base = process.env.TMPDIR || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, 'build-gas-test-'));
  const put = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  };
  put('index.html', readText('index.html'));
  put('css/style.css', 'body { margin: 0; }\n');
  put('js/main.js', main);
  put('node_modules/matter-js/package.json', JSON.stringify({ name: 'matter-js', version: matterVersion }));
  put('node_modules/matter-js/build/matter.min.js', matterCode ?? `/*! matter-js ${matterVersion} */\nvar Matter = {};\n//# sourceMappingURL=matter.min.js.map\n`);
  return { dir, put, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('bundleApp: esbuild 오류(최상위 await)와 경고(import.meta)는 BuildError 로 실패한다', () => {
  for (const [main, re] of [
    ['const x = await Promise.resolve(1);\nexport {};\n', /Top-level await/],
    ['console.log(import.meta.url);\n', /import\.meta/],
    ['import "./missing.js";\n', /missing/],
  ]) {
    const fx = makeFixture({ main });
    try {
      assert.throws(() => bundleApp({ root: fx.dir }), (e) => e instanceof BuildError && re.test(e.message), main);
    } finally {
      fx.cleanup();
    }
  }
});

test('bundleApp: 결과는 체크아웃 위치와 무관하다 (상대 경로 주석만 사용)', () => {
  const a = makeFixture({ main: 'import "./dep.js";\nexport {};\n' });
  const b = makeFixture({ main: 'import "./dep.js";\nexport {};\n' });
  try {
    a.put('js/dep.js', 'window.__dep = 1;\n');
    b.put('js/dep.js', 'window.__dep = 1;\n');
    const out = bundleApp({ root: a.dir });
    assert.equal(out, bundleApp({ root: b.dir }));
    assert.ok(out.includes('// js/dep.js') && !out.includes(a.dir));
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('readMatter: 소스맵 줄을 제거하고, 머리말 버전이 package.json 과 다르면 던진다', () => {
  const ok = makeFixture();
  const bad = makeFixture({ matterVersion: '0.19.0', matterCode: '/*! matter-js 0.18.0 */\nvar Matter = {};\n' });
  try {
    const m = readMatter({ root: ok.dir });
    assert.equal(m.version, '0.19.0');
    assert.ok(!/sourceMappingURL/.test(m.code));
    assert.ok(m.code.endsWith('var Matter = {};'));
    assert.throws(() => readMatter({ root: bad.dir }), (e) => e instanceof BuildError && /matter-js 0\.19\.0/.test(e.message));
  } finally {
    ok.cleanup();
    bad.cleanup();
  }
});

// ── CLI ───────────────────────────────────────────────────

test('CLI(main): 쓰기 → --check 통과 → 변조/삭제 시 --check 실패, 잘못된 인자는 2', () => {
  const fx = makeFixture();
  const logs = [];
  const errs = [];
  const io = { root: fx.dir, log: (m) => logs.push(m), err: (m) => errs.push(m) };
  try {
    const out = path.join(fx.dir, 'gas', 'Index.html');
    assert.equal(main(['--check'], io), 1, '파일이 없으면 --check 실패');
    assert.equal(main([], io), 0);
    assert.deepEqual(fs.readdirSync(path.join(fx.dir, 'gas')), ['Index.html'], '빌더는 gas/Index.html 외에는 쓰지 않는다');
    assert.equal(fs.readFileSync(out, 'utf8'), assembleHtml({
      indexHtml: readText('index.html'),
      css: 'body { margin: 0; }\n',
      matter: readMatter({ root: fx.dir }),
      appJs: bundleApp({ root: fx.dir }),
    }));
    assert.equal(main(['--check'], io), 0);
    fs.appendFileSync(out, '<!-- hand edit -->\n');
    assert.equal(main(['--check'], io), 1);
    assert.match(errs.at(-1), /원본과 다릅니다/);
    assert.equal(main(['--bogus'], io), 2);
    // 빌드가 실패하면 아무것도 쓰지 않고 1
    fs.rmSync(out);
    fx.put('js/main.js', 'const x = await 1;\n');
    assert.equal(main([], io), 1);
    assert.ok(!fs.existsSync(out), '실패한 빌드는 출력 파일을 만들지 않는다');
  } finally {
    fx.cleanup();
  }
});

test('CLI(프로세스): node scripts/build-gas.mjs --check 는 0, 알 수 없는 인자는 2', () => {
  const run = (...args) => spawnSync(process.execPath, [rootPath('scripts/build-gas.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });
  const ok = run('--check');
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  assert.match(ok.stdout, /최신입니다/);
  const bad = run('--bogus');
  assert.equal(bad.status, 2);
});

// ── package.json / 잠금 파일 ──────────────────────────────

test('esbuild 는 정확한 버전으로 고정되어 있고 build:gas 스크립트가 있다', () => {
  const pkg = JSON.parse(readText('package.json'));
  const lock = JSON.parse(readText('package-lock.json'));
  assert.match(pkg.devDependencies.esbuild, /^\d+\.\d+\.\d+$/, '범위(^,~) 없이 정확한 버전');
  assert.equal(pkg.scripts['build:gas'], 'node scripts/build-gas.mjs');
  assert.equal(lock.packages['node_modules/esbuild']?.version, pkg.devDependencies.esbuild, '잠금 파일과 같은 버전');
  assert.equal(lock.packages[''].devDependencies.esbuild, pkg.devDependencies.esbuild);
  assert.equal(pkg.devDependencies['matter-js'], '0.19.0');
  assert.equal(pkg.dependencies, undefined, '런타임 의존성 없음: 배포물은 gas/ 세 파일뿐');
});
