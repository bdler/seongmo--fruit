// localStorage 안전 래퍼. 사생활 보호 모드/차단/용량 초과 등으로 접근이 예외를 던져도
// 게임은 계속 돌아가야 하므로 모든 접근을 try/catch 로 감싸고 메모리에 사본을 둔다.
import { STORAGE_KEYS, NICKNAME_MAX } from './config.js';

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const defaultBackend = () => globalThis.localStorage;

// getBackend 는 호출 때마다 평가한다(접근 자체가 SecurityError 를 던질 수 있고, 테스트에서 교체한다).
export function createStorage({ getBackend = defaultBackend } = {}) {
  const memory = new Map();

  function read(key) {
    try {
      const value = getBackend()?.getItem(key);
      if (typeof value === 'string') return value;
    } catch {
      // 아래 메모리 사본으로 대체
    }
    return memory.has(key) ? memory.get(key) : null;
  }

  function write(key, value) {
    memory.set(key, value);
    try {
      getBackend()?.setItem(key, value);
    } catch {
      // 메모리에는 남아 있으므로 이번 세션에서는 유효
    }
  }

  function remove(key) {
    memory.delete(key);
    try {
      getBackend()?.removeItem(key);
    } catch {
      // ignore
    }
  }

  // 저장된 문자열은 '0 이상의 정수 자릿수'만 인정한다(NaN, 음수, 16진수, 지수 표기는 쓰레기 값).
  const parseScore = (raw) => {
    const text = String(raw).trim();
    if (!/^\d+$/.test(text)) return 0;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : 0;
  };

  const sanitizeScore = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER) : 0;
  };

  const cleanNickname = (raw) =>
    String(raw ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, NICKNAME_MAX);

  function getBest() {
    const raw = read(STORAGE_KEYS.best);
    return raw === null ? 0 : parseScore(raw);
  }

  function setBest(score) {
    write(STORAGE_KEYS.best, String(sanitizeScore(score)));
  }

  function getNickname() {
    const raw = read(STORAGE_KEYS.nickname);
    return raw === null ? '' : cleanNickname(raw);
  }

  function setNickname(nickname) {
    write(STORAGE_KEYS.nickname, cleanNickname(nickname));
  }

  function getMuted() {
    return read(STORAGE_KEYS.muted) === '1';
  }

  function setMuted(muted) {
    write(STORAGE_KEYS.muted, muted ? '1' : '0');
  }

  // 제출 대기 중인 점수. 형식이 깨진 값은 없는 것으로 취급한다.
  function getPending() {
    const raw = read(STORAGE_KEYS.pending);
    if (raw === null) return null;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const nickname = typeof data.nickname === 'string' ? cleanNickname(data.nickname) : '';
    const nums = ['score', 'maxLevel', 'playTimeMs', 'drops'];
    if (!nickname || !nums.every((k) => typeof data[k] === 'number' && Number.isFinite(data[k]))) {
      return null;
    }
    const pending = {
      nickname,
      score: data.score,
      maxLevel: data.maxLevel,
      playTimeMs: data.playTimeMs,
      drops: data.drops,
    };
    if (typeof data.clientId === 'string' && CLIENT_ID_RE.test(data.clientId)) {
      pending.clientId = data.clientId;
    }
    return pending;
  }

  function setPending(payload) {
    let json;
    try {
      json = JSON.stringify(payload);
    } catch {
      return;
    }
    if (typeof json === 'string') write(STORAGE_KEYS.pending, json);
  }

  function clearPending() {
    remove(STORAGE_KEYS.pending);
  }

  function makeClientId() {
    try {
      const c = globalThis.crypto;
      if (typeof c?.randomUUID === 'function') return c.randomUUID();
      if (typeof c?.getRandomValues === 'function') {
        const bytes = c.getRandomValues(new Uint8Array(18));
        return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
      }
    } catch {
      // Math.random 으로 대체
    }
    let id = '';
    while (id.length < 32) id += Math.random().toString(36).slice(2);
    return id.slice(0, 32);
  }

  // 한 번 만든 id 는 저장되어 이후에도 같은 값을 돌려준다(저장이 막혀도 세션 동안은 유지).
  function getClientId() {
    const saved = read(STORAGE_KEYS.clientId);
    if (saved !== null && CLIENT_ID_RE.test(saved)) return saved;
    let id = makeClientId();
    if (!CLIENT_ID_RE.test(id)) id = id.replace(/[^A-Za-z0-9_-]/g, '').padEnd(16, '0').slice(0, 64);
    write(STORAGE_KEYS.clientId, id);
    return id;
  }

  return {
    getBest,
    setBest,
    getNickname,
    setNickname,
    getMuted,
    setMuted,
    getPending,
    setPending,
    clearPending,
    getClientId,
  };
}

const storage = createStorage();

export const {
  getBest,
  setBest,
  getNickname,
  setNickname,
  getMuted,
  setMuted,
  getPending,
  setPending,
  clearPending,
  getClientId,
} = storage;
