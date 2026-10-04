import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STORAGE_KEYS, NICKNAME_MAX } from '../js/config.js';
import * as defaultStorage from '../js/storage.js';
import { createStorage } from '../js/storage.js';

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

// 정상 동작하는 localStorage 흉내
function fakeBackend(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
}

// 모든 접근이 예외를 던지는 localStorage (사생활 보호 모드 등)
function throwingBackend() {
  const boom = () => {
    throw new Error('SecurityError');
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

const pendingPayload = () => ({
  nickname: '수박왕',
  score: 321,
  maxLevel: 7,
  playTimeMs: 90000,
  drops: 80,
  clientId: 'abcdefghijklmnop1234',
});

// 세 가지 '저장소를 못 쓰는' 상황 모두에서 같은 보장을 확인한다.
const broken = {
  'getItem/setItem/removeItem 이 모두 예외': () => createStorage({ getBackend: throwingBackend }),
  'localStorage 접근 자체가 예외 (SecurityError)': () =>
    createStorage({
      getBackend: () => {
        throw new Error('SecurityError');
      },
    }),
  'localStorage 가 없음 (undefined)': () => createStorage({ getBackend: () => undefined }),
  'localStorage 가 null': () => createStorage({ getBackend: () => null }),
};

for (const [name, make] of Object.entries(broken)) {
  test(`저장소를 쓸 수 없음 - ${name}: 던지지 않고 메모리로 동작`, () => {
    const s = make();
    assert.equal(s.getBest(), 0);
    assert.equal(s.getNickname(), '');
    assert.equal(s.getMuted(), false);
    assert.equal(s.getPending(), null);

    assert.doesNotThrow(() => s.setBest(120));
    assert.equal(s.getBest(), 120);
    s.setNickname('  치즈  ');
    assert.equal(s.getNickname(), '치즈');
    s.setMuted(true);
    assert.equal(s.getMuted(), true);
    s.setMuted(false);
    assert.equal(s.getMuted(), false);

    s.setPending(pendingPayload());
    assert.deepEqual(s.getPending(), pendingPayload());
    assert.doesNotThrow(() => s.clearPending());
    assert.equal(s.getPending(), null);

    const id = s.getClientId();
    assert.match(id, CLIENT_ID_RE);
    assert.equal(s.getClientId(), id, '저장이 막혀도 세션 동안 같은 id');
  });
}

test('쓰기만 막힌 저장소(용량 초과): 읽기는 메모리 사본으로 이어진다', () => {
  const backend = fakeBackend();
  backend.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  const s = createStorage({ getBackend: () => backend });
  s.setBest(77);
  assert.equal(s.getBest(), 77);
  assert.equal(backend.data.size, 0);
});

test('정상 저장소: 값이 키 이름대로 저장되고 새 인스턴스에서도 읽힌다', () => {
  const backend = fakeBackend();
  const a = createStorage({ getBackend: () => backend });
  a.setBest(1234);
  a.setNickname('과일러');
  a.setMuted(true);
  a.setPending(pendingPayload());
  assert.equal(backend.data.get(STORAGE_KEYS.best), '1234');
  assert.equal(backend.data.get(STORAGE_KEYS.nickname), '과일러');
  assert.equal(backend.data.get(STORAGE_KEYS.muted), '1');
  assert.ok(backend.data.has(STORAGE_KEYS.pending));

  const b = createStorage({ getBackend: () => backend });
  assert.equal(b.getBest(), 1234);
  assert.equal(b.getNickname(), '과일러');
  assert.equal(b.getMuted(), true);
  assert.deepEqual(b.getPending(), pendingPayload());

  b.clearPending();
  assert.equal(backend.data.has(STORAGE_KEYS.pending), false);
  assert.equal(createStorage({ getBackend: () => backend }).getPending(), null);
});

test('쓰레기 값: 최고 점수가 NaN/음수/문자열이면 0', () => {
  const garbage = ['NaN', 'abc', '-5', 'Infinity', '-Infinity', '', '   ', '0x10', '1e3', '12.5', 'null', 'undefined', '{}', '99999999999999999999'];
  for (const raw of garbage) {
    const s = createStorage({ getBackend: () => fakeBackend({ [STORAGE_KEYS.best]: raw }) });
    assert.equal(s.getBest(), 0, JSON.stringify(raw));
  }
  const ok = createStorage({ getBackend: () => fakeBackend({ [STORAGE_KEYS.best]: ' 42 ' }) });
  assert.equal(ok.getBest(), 42);
});

test('setBest: 이상한 입력도 안전한 정수로 저장', () => {
  const backend = fakeBackend();
  const s = createStorage({ getBackend: () => backend });
  for (const [input, expected] of [[NaN, '0'], [-3, '0'], [Infinity, '0'], ['abc', '0'], [undefined, '0'], [12.9, '12'], ['55', '55']]) {
    s.setBest(input);
    assert.equal(backend.data.get(STORAGE_KEYS.best), expected, String(input));
    assert.equal(s.getBest(), Number(expected));
  }
});

test('쓰레기 값: 닉네임은 길이/제어문자가 정리된다', () => {
  const long = 'ㄱ'.repeat(NICKNAME_MAX + 8);
  const s = createStorage({ getBackend: () => fakeBackend({ [STORAGE_KEYS.nickname]: long }) });
  assert.equal(s.getNickname().length, NICKNAME_MAX);
  const ctl = createStorage({ getBackend: () => fakeBackend({ [STORAGE_KEYS.nickname]: ' a\u0000b\nc\u007f ' }) });
  assert.equal(ctl.getNickname(), 'abc');
  const set = createStorage({ getBackend: () => fakeBackend() });
  set.setNickname('x'.repeat(40));
  assert.equal(set.getNickname().length, NICKNAME_MAX);
  set.setNickname(undefined);
  assert.equal(set.getNickname(), '');
});

test('쓰레기 값: 음소거는 "1" 일 때만 true', () => {
  for (const raw of ['0', 'true', 'yes', '', 'abc', '2']) {
    const s = createStorage({ getBackend: () => fakeBackend({ [STORAGE_KEYS.muted]: raw }) });
    assert.equal(s.getMuted(), false, JSON.stringify(raw));
  }
});

test('쓰레기 값: 제출 대기 점수는 형식이 맞아야 하고 아니면 null', () => {
  const good = pendingPayload();
  const cases = [
    'not json',
    '{"a":',
    'null',
    '123',
    '[]',
    '"str"',
    JSON.stringify({ ...good, score: 'many' }),
    JSON.stringify({ ...good, score: null }), // NaN 은 JSON 에서 null 이 된다
    JSON.stringify({ ...good, nickname: '' }),
    JSON.stringify({ ...good, nickname: 123 }),
    JSON.stringify({ ...good, drops: undefined }),
    JSON.stringify({ nickname: 'x' }),
  ];
  for (const raw of cases) {
    const s = createStorage({ getBackend: () => fakeBackend({ [STORAGE_KEYS.pending]: raw }) });
    assert.equal(s.getPending(), null, raw);
  }
  // 알 수 없는 필드는 버리고, 형식이 틀린 clientId 는 빼서 돌려준다
  const dirty = createStorage({
    getBackend: () => fakeBackend({ [STORAGE_KEYS.pending]: JSON.stringify({ ...good, clientId: 'short', evil: '<script>' }) }),
  });
  const got = dirty.getPending();
  assert.equal('evil' in got, false);
  assert.equal('clientId' in got, false);
  assert.equal(got.score, good.score);
});

test('clientId: 형식, 생성 후 영속, 새 인스턴스에서도 동일', () => {
  const backend = fakeBackend();
  const a = createStorage({ getBackend: () => backend });
  const id = a.getClientId();
  assert.match(id, CLIENT_ID_RE);
  assert.equal(backend.data.get(STORAGE_KEYS.clientId), id);
  assert.equal(a.getClientId(), id);
  assert.equal(createStorage({ getBackend: () => backend }).getClientId(), id);
});

test('clientId: 저장된 값이 형식에 안 맞으면 새로 만든다', () => {
  for (const raw of ['', 'short', 'has space in it 1234567890', 'x'.repeat(65), '한글한글한글한글한글한글한글한글']) {
    const backend = fakeBackend({ [STORAGE_KEYS.clientId]: raw });
    const s = createStorage({ getBackend: () => backend });
    const id = s.getClientId();
    assert.match(id, CLIENT_ID_RE, JSON.stringify(raw));
    assert.notEqual(id, raw);
    assert.equal(backend.data.get(STORAGE_KEYS.clientId), id, '새 값이 저장된다');
  }
  // 형식이 맞으면 그대로 유지
  const keep = createStorage({ getBackend: () => fakeBackend({ [STORAGE_KEYS.clientId]: 'valid_ID-1234567890' }) });
  assert.equal(keep.getClientId(), 'valid_ID-1234567890');
});

test('clientId: 서로 다른 저장소는 서로 다른 id 를 만든다', () => {
  const ids = new Set(Array.from({ length: 20 }, () => createStorage({ getBackend: () => fakeBackend() }).getClientId()));
  assert.equal(ids.size, 20);
});

test('clientId: crypto.randomUUID 가 없어도 (getRandomValues / Math.random) 형식 유지', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const override = (value) => Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
  try {
    override({ getRandomValues: (arr) => arr.fill(255) });
    const withRandomValues = createStorage({ getBackend: () => fakeBackend() }).getClientId();
    assert.match(withRandomValues, CLIENT_ID_RE);

    override(undefined);
    const withMathRandom = createStorage({ getBackend: () => fakeBackend() }).getClientId();
    assert.match(withMathRandom, CLIENT_ID_RE);

    override({
      randomUUID: () => {
        throw new Error('insecure context');
      },
    });
    const withThrowing = createStorage({ getBackend: () => fakeBackend() }).getClientId();
    assert.match(withThrowing, CLIENT_ID_RE);
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  }
});

test('기본 export 함수: 이 환경(localStorage 없음/차단)에서도 던지지 않는다', () => {
  const names = ['getBest', 'setBest', 'getNickname', 'setNickname', 'getMuted', 'setMuted', 'getPending', 'setPending', 'clearPending', 'getClientId'];
  for (const name of names) assert.equal(typeof defaultStorage[name], 'function', name);
  assert.doesNotThrow(() => {
    defaultStorage.setBest(5);
    defaultStorage.getBest();
    defaultStorage.setNickname('a');
    defaultStorage.setMuted(true);
    defaultStorage.setPending(pendingPayload());
    defaultStorage.clearPending();
  });
  assert.match(defaultStorage.getClientId(), CLIENT_ID_RE);
});
