// 정적 파일(index.html, css, package.json)의 계약 검증. 브라우저 없이 텍스트로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../index.html');
const css = read('../css/style.css');
const pkg = JSON.parse(read('../package.json'));

// ── index.html ───────────────────────────────────────────

test('뷰포트 메타는 확대를 막지 않는다 (WCAG 1.4.4)', () => {
  const m = /<meta name="viewport" content="([^"]*)"/.exec(html);
  assert.ok(m, 'viewport 메타가 있어야 함');
  assert.equal(m[1], 'width=device-width, initial-scale=1, viewport-fit=cover');
});

test('음소거 버튼: 이름은 고정하고 상태는 aria-pressed 로만 알린다', () => {
  const tag = /<button id="btn-mute"[^>]*>/.exec(html)?.[0];
  assert.ok(tag);
  assert.match(tag, /aria-pressed="false"/);
  assert.match(tag, /aria-label="음소거"/);
  const main = read('../js/main.js');
  assert.ok(!/btnMute\.setAttribute\('aria-label'/.test(main), 'main.js 가 라벨을 바꾸면 "소리 켜기, 눌림" 처럼 모순된 낭독이 된다');
});

// ── package.json ─────────────────────────────────────────

test('npm test 는 따옴표 친 glob 에 기대지 않는다 (Node 20 에서 0개 실행으로 죽음)', () => {
  assert.ok(!/["'*]/.test(pkg.scripts.test), `scripts.test = ${pkg.scripts.test}`);
});

test('Node 최소 버전과 브라우저 설치 스크립트를 선언한다', () => {
  assert.match(pkg.engines?.node ?? '', /^>=\d+/);
  assert.match(pkg.scripts['e2e:install'] ?? '', /playwright-core install chromium/);
  assert.match(read('../.nvmrc').trim(), /^\d+$/);
});

// ── 색 대비 (WCAG 2.x AA: 일반 글자 4.5:1, 큰 글자 3:1) ───────────

const hex = (h) => {
  const v = h.replace('#', '');
  const full = v.length === 3 ? [...v].map((c) => c + c).join('') : v;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const lin = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fg, alpha, bg) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));

const variable = (name) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`).exec(css);
  assert.ok(m, `--${name} 변수를 찾을 수 없음`);
  return m[1];
};
const rule = (selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `${selector} 규칙을 찾을 수 없음`);
  return m[1];
};
const WHITE = hex('#ffffff');
const CARD = hex(variable('card'));
const AA = 4.5;

test('색 대비: 기본 버튼의 흰 글자는 그라데이션 양 끝에서 4.5:1 이상', () => {
  const body = rule('.btn.primary');
  const stops = [...body.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]).filter((c) => c.toLowerCase() !== '#ffffff');
  assert.ok(stops.length >= 2, `그라데이션 색을 못 읽음: ${body}`);
  for (const c of stops) assert.ok(ratio(WHITE, hex(c)) >= AA, `흰색 / ${c} = ${ratio(WHITE, hex(c)).toFixed(2)}`);
});

test('색 대비: 최종 점수와 HUD 점수는 진한 강조색을 쓴다', () => {
  assert.match(rule('.final strong'), /color:\s*var\(--accent-dark\)/);
  const dark = hex(variable('accent-dark'));
  assert.ok(ratio(dark, CARD) >= AA, `accent-dark / 카드 = ${ratio(dark, CARD).toFixed(2)}`);
  const hud = over(WHITE, 0.62, hex('#ffe9b8')); // HUD 가 가장 어두운 배경 위에 있을 때
  assert.ok(ratio(dark, hud) >= AA, `accent-dark / HUD = ${ratio(dark, hud).toFixed(2)}`);
});

test('색 대비: 보조 글자색(--ink-soft)은 카드/HUD/목록/안내 상자 위에서 4.5:1 이상', () => {
  const soft = hex(variable('ink-soft'));
  const backgrounds = {
    카드: CARD,
    'HUD(밝은 쪽)': over(WHITE, 0.62, hex('#fff4d6')),
    'HUD(어두운 쪽)': over(WHITE, 0.62, hex('#ffe9b8')),
    '랭킹 행': over(hex('#fff4d6'), 0.6, CARD),
    '안내 상자': hex('#fff3d1'),
  };
  for (const [name, bg] of Object.entries(backgrounds)) {
    assert.ok(ratio(soft, bg) >= AA, `--ink-soft / ${name} = ${ratio(soft, bg).toFixed(2)}`);
  }
});

test('색 대비: 1~3위 순위 숫자는 각 행 그라데이션의 어두운 쪽에서도 4.5:1 이상', () => {
  for (const n of [1, 2, 3]) {
    const bg = new RegExp(`\\.ranking > li:nth-child\\(${n}\\) \\{ background: linear-gradient\\(90deg, (#[0-9a-f]{6}), (#[0-9a-f]{6})\\)`, 'i').exec(css);
    const fg = new RegExp(`\\.ranking > li:nth-child\\(${n}\\) > :nth-child\\(1\\) \\{ color: (#[0-9a-f]{6})`, 'i').exec(css);
    assert.ok(bg && fg, `${n}위 규칙을 찾을 수 없음`);
    for (const stop of [bg[1], bg[2]]) {
      assert.ok(ratio(hex(fg[1]), hex(stop)) >= AA, `${n}위 ${fg[1]} / ${stop} = ${ratio(hex(fg[1]), hex(stop)).toFixed(2)}`);
    }
  }
});

// ── 레이아웃 계약 ────────────────────────────────────────

test('닉네임 줄은 뷰포트 폭이 아니라 콘텐츠 폭으로 줄바꿈한다', () => {
  assert.match(rule('form .row'), /flex-wrap:\s*wrap/);
  assert.match(rule('form .row input'), /flex:\s*1 1 9em/);
  assert.ok(!/@media \(max-width:\s*359px\)/.test(css), '뷰포트 폭 기준의 특례는 필요 없다');
});

test('낮은 가로 화면에는 전용 배치가 있고, 시작 버튼 줄은 스크롤해도 보인다', () => {
  assert.match(css, /@media \(orientation: landscape\) and \(max-height: 500px\)/);
  assert.match(rule('.panel > .btn-row'), /position:\s*sticky/);
});
