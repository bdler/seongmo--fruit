#!/usr/bin/env node
// Apps Script 배포용 단일 파일 빌더.
//
// index.html + css/style.css + js/**/*.js(esbuild 번들) + Matter.js 를 한 개의 HTML(gas/Index.html)로 합친다.
// Apps Script 프로젝트에는 Code.gs / Index.html / appsscript.json 세 파일만 올리면 된다.
//
// 사용:
//   npm run build:gas                      gas/Index.html 을 (다시) 만든다
//   node scripts/build-gas.mjs --check     커밋된 gas/Index.html 이 최신인지만 확인한다 (다르면 종료 코드 1)
//
// 라이브러리로도 쓴다 (tests/build.test.mjs):
//   buildGasHtml({ root })  → 완성된 HTML 문자열 (파일을 쓰지 않는다)
//   assembleHtml(parts)     → 이미 읽어 둔 조각을 끼워 맞추는 순수 함수 (입출력 없음)
//   bundleApp({ root })     → js/main.js 를 클래식(IIFE) 스크립트 문자열로 번들
//
// 결정적(deterministic): 같은 입력이면 바이트까지 같은 출력. 줄바꿈은 항상 LF, 끝은 개행 하나.
// 시끄럽게 실패: 기대한 표식(marker)이 정확히 한 번 있지 않거나, 인라인 코드에 </script, <!--, --> 같은
// HTML 파서 위험 문자열이 있으면 예외를 던지고 아무것도 쓰지 않는다.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..');
export const OUTPUT_REL = 'gas/Index.html';
export const BUILD_COMMAND = 'npm run build:gas';

const MATTER_REL = 'node_modules/matter-js/build/matter.min.js';
const MATTER_PKG_REL = 'node_modules/matter-js/package.json';

export class BuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildError';
  }
}

// ── 문자열 도우미 ─────────────────────────────────────────

// 줄바꿈을 LF 로 통일하고 BOM 을 떼어 낸다 (Windows 체크아웃에서도 같은 출력).
const normalize = (text) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

// String.prototype.replace 는 대체 문자열의 `$&`, `$1` 을 해석한다. CSS/JS 에는 `$` 가 흔하므로
// 쓰지 않고, 표식이 정확히 한 번 있는지 확인한 뒤 잘라 붙인다.
function replaceOnce(source, marker, replacement, label) {
  const first = source.indexOf(marker);
  if (first < 0) {
    throw new BuildError(`index.html 에서 표식을 찾지 못했습니다: ${label}\n  기대한 문자열: ${marker}`);
  }
  if (source.indexOf(marker, first + marker.length) >= 0) {
    throw new BuildError(`index.html 에 표식이 두 번 이상 있습니다 (정확히 한 번이어야 함): ${label}\n  문자열: ${marker}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + marker.length);
}

// ── 위험 문자열 검사 ──────────────────────────────────────
// 인라인 <script>/<style> 안에서 HTML 파서를 속일 수 있는 문자열. 이스케이프로 몰래 고치기보다
// 거부해서 원인을 사람이 보게 한다. (esbuild 는 문자열 속 `</script` 를 스스로 `<\/script` 로 바꿔 준다.)
const HAZARDS = [
  { re: /<\/script/i, name: '</script (인라인 스크립트가 거기서 끝나 버림)' },
  { re: /<\/style/i, name: '</style (인라인 스타일이 거기서 끝나 버림)' },
  { re: /<!--/, name: '<!-- (HTML 주석/이중 이스케이프 상태 진입)' },
  { re: /-->/, name: '--> (HTML 주석 종료 또는 JS 의 HTML-like 주석)' },
  // Apps Script 템플릿 스크립틀릿 시작. createHtmlOutputFromFile 은 해석하지 않지만, 누군가 템플릿으로 바꿔도 안전하도록.
  { re: /<\?/, name: '<? (Apps Script 스크립틀릿 시작)' },
  { re: /[\u2028\u2029]/, name: 'U+2028/U+2029 (옛 엔진에서 줄바꿈으로 취급되는 문자)' },
  { re: /\u0000/, name: 'NUL 문자' },
];

export function assertSafeInline(label, text) {
  for (const { re, name } of HAZARDS) {
    const m = re.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split('\n').length;
      const around = text.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\n/g, '\\n');
      throw new BuildError(`${label} 안에 위험한 문자열이 있습니다: ${name}\n  ${label} ${line}번째 줄 근처: …${around}…`);
    }
  }
}

// CSS 가 외부 자원을 끌어오면 Apps Script 샌드박스에서 깨진다. data: URI 만 허용한다.
function assertSelfContainedCss(css, label = 'css/style.css') {
  if (/@import\b/i.test(css)) throw new BuildError(`${label} 에 @import 가 있습니다. 외부 자원 없이 한 파일이어야 합니다.`);
  const bad = /url\(\s*(['"]?)(?!data:|#)/i.exec(css);
  if (bad) {
    const at = css.slice(bad.index, bad.index + 60).replace(/\n/g, '\\n');
    throw new BuildError(`${label} 에 data: 가 아닌 url(...) 이 있습니다: ${at}\n  외부/상대 경로 자원은 단일 HTML 에 들어가지 않습니다.`);
  }
}

// ── 조각 만들기 ───────────────────────────────────────────

// js/main.js 와 import 하는 모든 모듈을 하나의 클래식 스크립트(IIFE)로. 압축하지 않아 읽을 수 있다.
export function bundleApp({ root = DEFAULT_ROOT, entry = 'js/main.js' } = {}) {
  let result;
  try {
    result = buildSync({
      entryPoints: [entry],
      absWorkingDir: root, // 번들 안의 `// js/xxx.js` 주석이 체크아웃 위치와 무관해진다
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      minify: false,
      charset: 'utf8', // 한글/이모지를 \u 이스케이프로 바꾸지 않는다
      legalComments: 'none',
      sourcemap: false,
      write: false,
      logLevel: 'silent',
      // ES 모듈은 항상 strict 모드. IIFE 로 풀면 esbuild 가 "use strict" 를 붙이지 않으므로 직접 붙여
      // 모듈 시절의 의미(예: 동결 객체 쓰기 시 TypeError)를 유지한다. 스크립트 단위 지시문이라 Matter 에는 영향 없음.
      banner: { js: '"use strict";' },
    });
  } catch (err) {
    const msgs = (err.errors ?? []).map((e) => `  ${e.location ? `${e.location.file}:${e.location.line}: ` : ''}${e.text}`);
    throw new BuildError(`esbuild 번들 실패:\n${msgs.length ? msgs.join('\n') : err.message}`);
  }
  if (result.warnings.length > 0) {
    const msgs = result.warnings.map((w) => `  ${w.location ? `${w.location.file}:${w.location.line}: ` : ''}${w.text}`);
    throw new BuildError(`esbuild 경고가 있습니다 (경고도 실패로 취급):\n${msgs.join('\n')}`);
  }
  if (result.outputFiles.length !== 1) {
    throw new BuildError(`esbuild 출력이 파일 1개여야 하는데 ${result.outputFiles.length}개입니다.`);
  }
  return normalize(result.outputFiles[0].text).trimEnd();
}

export function readMatter({ root = DEFAULT_ROOT } = {}) {
  const version = JSON.parse(readFileSync(path.join(root, MATTER_PKG_REL), 'utf8')).version;
  const raw = normalize(readFileSync(path.join(root, MATTER_REL), 'utf8'));
  // 소스맵 참조 줄 제거: 인라인에서는 가리킬 파일이 없고, 열면 404 를 낸다.
  const code = raw.replace(/^[ \t]*\/\/[#@][ \t]*sourceMappingURL=.*$/gm, '').trimEnd();
  if (!code.includes(`matter-js ${version}`)) {
    throw new BuildError(`${MATTER_REL} 머리말에 "matter-js ${version}" 이 없습니다. node_modules 가 package.json 과 어긋났나요? (npm ci 를 다시 실행)`);
  }
  return { version, code };
}

// ── 조립 (순수 함수) ──────────────────────────────────────

// index.html 의 개발용 주석. 빌드 결과에서는 사실과 달라지므로 있으면 지운다 (없어도 실패하지 않음).
const STALE_COMMENT_RE = /^[ \t]*<!-- 물리 엔진: 버전 고정\.[^\n]*-->\n/m;

export function headerComment() {
  return [
    '<!--',
    '  GENERATED FILE. DO NOT EDIT. (자동 생성 파일입니다. 직접 수정하지 마세요.)',
    '',
    `  Generated by:  ${BUILD_COMMAND}   (scripts/build-gas.mjs)`,
    '  Sources:       index.html, css/style.css, js/*.js (esbuild bundle), node_modules/matter-js/build/matter.min.js',
    '',
    '  To change the game: edit the source files above, run the command, and upload this file to Apps Script.',
    '  Edits made to this file will be overwritten by the next build.',
    '  게임을 고치려면 위 원본 파일을 수정한 뒤 위 명령을 다시 실행하세요.',
    '-->',
    '',
  ].join('\n');
}

// parts: { indexHtml, css, matter: {version, code}, appJs }  — 모두 문자열이며 입출력은 하지 않는다.
export function assembleHtml({ indexHtml, css, matter, appJs }) {
  let html = normalize(indexHtml);
  const cssText = normalize(css).trimEnd();
  const matterCode = normalize(matter.code).trimEnd();
  const app = normalize(appJs).trimEnd();

  if (!/^<!doctype html>\n/i.test(html)) {
    throw new BuildError('index.html 이 "<!doctype html>" 한 줄로 시작하지 않습니다.');
  }
  for (const tag of ['<head>', '</head>', '<body>', '</body>']) {
    const n = html.split(tag).length - 1;
    if (n !== 1) throw new BuildError(`index.html 에 ${tag} 가 ${n}번 있습니다 (정확히 한 번이어야 함).`);
  }

  assertSelfContainedCss(cssText);
  assertSafeInline('css/style.css', cssText);
  assertSafeInline('Matter.js', matterCode);
  assertSafeInline('앱 번들(js/main.js)', app);

  const markers = {
    stylesheet: '<link rel="stylesheet" href="./css/style.css">',
    matterCdn: `<script src="https://cdnjs.cloudflare.com/ajax/libs/matter-js/${matter.version}/matter.min.js"></script>`,
    appModule: '<script type="module" src="./js/main.js"></script>',
  };

  html = html.replace(STALE_COMMENT_RE, () => '');
  html = replaceOnce(html, markers.stylesheet, `<style>\n${cssText}\n</style>`, 'css/style.css <link>');
  html = replaceOnce(
    html,
    markers.matterCdn,
    `<!-- Matter.js ${matter.version} (MIT) — node_modules/matter-js/build/matter.min.js 를 그대로 넣음. 앱 스크립트보다 먼저 실행되어 전역 Matter 를 만든다. -->\n  <script>\n${matterCode}\n</script>`,
    `Matter.js CDN <script> (버전은 node_modules/matter-js ${matter.version} 와 같아야 함)`,
  );
  html = replaceOnce(
    html,
    markers.appModule,
    `<!-- 앱: js/main.js 와 import 하는 모든 모듈을 esbuild 로 묶은 클래식 스크립트 (압축 안 함). -->\n  <script>\n${app}\n</script>`,
    'js/main.js <script type="module">',
  );

  // 최종 방어선: 조립 결과에 외부/상대 자원 참조가 남아 있으면 안 된다 (favicon 의 data: URI 만 허용).
  // 앱 번들/Matter 코드 안의 문자열은 제외하고 태그 속성만 보기 위해, 스크립트·스타일의 '본문'만 비운 사본으로 검사한다.
  // (여는 태그는 남겨야 index.html 에 직접 쓴 <script src=...> 가 걸린다.)
  const skeleton = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, '$1$3');
  // 값은 따옴표로 감싸도 되고 감싸지 않아도 된다: src="x", src='x', src=x
  const leftovers = [...skeleton.matchAll(/\b(?:src|href)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gi)]
    .map((m) => m[2] ?? m[3])
    .filter((v) => !v.startsWith('data:'));
  if (leftovers.length > 0) {
    throw new BuildError(`조립 결과에 외부/상대 자원 참조가 남아 있습니다: ${leftovers.join(', ')}`);
  }
  // index.html 에 직접 쓴 <style> 의 @import/url() 도 css/style.css 와 같은 기준으로 막는다.
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) assertSelfContainedCss(m[1], '인라인 <style>');

  // 머리말 주석은 doctype 바로 '뒤'에 둔다. 문서가 주석이 아니라 doctype 으로 시작해야 HtmlService 가 어떻게 감싸든 표준 모드가 유지된다.
  const doctypeEnd = html.indexOf('\n') + 1;
  return `${html.slice(0, doctypeEnd)}${headerComment()}${html.slice(doctypeEnd).trimEnd()}\n`;
}

// ── 전체 빌드 ─────────────────────────────────────────────

export function buildGasHtml({ root = DEFAULT_ROOT } = {}) {
  const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
  return assembleHtml({
    indexHtml: read('index.html'),
    css: read('css/style.css'),
    matter: readMatter({ root }),
    appJs: bundleApp({ root }),
  });
}

// ── CLI ───────────────────────────────────────────────────

function firstDiffLine(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i += 1) if (la[i] !== lb[i]) return i + 1;
  return 0;
}

export function main(argv = process.argv.slice(2), { root = DEFAULT_ROOT, log = console.log, err = console.error } = {}) {
  const flags = new Set(argv);
  const unknown = argv.filter((a) => a !== '--check');
  if (unknown.length > 0) {
    err(`알 수 없는 인자: ${unknown.join(' ')}\n사용법: node scripts/build-gas.mjs [--check]`);
    return 2;
  }
  const outPath = path.join(root, OUTPUT_REL);
  let html;
  try {
    html = buildGasHtml({ root });
  } catch (e) {
    err(`build-gas 실패: ${e instanceof BuildError ? e.message : (e.stack ?? e)}`);
    return 1;
  }
  const size = Buffer.byteLength(html, 'utf8');

  if (flags.has('--check')) {
    let current = null;
    try {
      current = readFileSync(outPath, 'utf8');
    } catch {
      /* 없음 */
    }
    if (current === html) {
      log(`${OUTPUT_REL} 는 최신입니다 (${size} bytes).`);
      return 0;
    }
    err(
      current === null
        ? `${OUTPUT_REL} 가 없습니다. ${BUILD_COMMAND} 를 실행하세요.`
        : `${OUTPUT_REL} 가 원본과 다릅니다 (처음 다른 줄: ${firstDiffLine(current, html)}). ${BUILD_COMMAND} 를 실행하고 결과를 커밋하세요.`,
    );
    return 1;
  }

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, 'utf8');
  log(`${OUTPUT_REL} 생성 완료 (${size} bytes, ${(size / 1024).toFixed(1)} KiB).`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exitCode = main();
