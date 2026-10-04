// 게임 전역 설정. 수치는 모두 초기값이며 플레이테스트로 조정한다.
// 이 파일은 DOM/Matter에 의존하지 않는다 (Node에서도 import 가능해야 함).

// 플레이 영역은 x∈[0,width], y∈[0,height] 이다.
// 벽/바닥(두께 wall)은 이 영역 '바깥'에 놓이므로, 과일 중심의 이동 범위는 [r, width - r].
export const WORLD = { width: 400, height: 600, wall: 20, dangerY: 100, spawnY: 50 };

// sprite(이미지 URL)를 지정하면 렌더러가 이모지 대신 이미지를 그린다.
export const FRUITS = [
  { level: 0,  name: '체리',     radius: 16,  emoji: '🍒', color: '#e53935' },
  { level: 1,  name: '딸기',     radius: 22,  emoji: '🍓', color: '#ec407a' },
  { level: 2,  name: '포도',     radius: 30,  emoji: '🍇', color: '#8e24aa' },
  { level: 3,  name: '데코폰',   radius: 36,  emoji: '🍊', color: '#fb8c00' },
  { level: 4,  name: '감',       radius: 44,  emoji: '🟠', color: '#ef6c00' },
  { level: 5,  name: '사과',     radius: 54,  emoji: '🍎', color: '#d32f2f' },
  { level: 6,  name: '배',       radius: 64,  emoji: '🍐', color: '#c0ca33' },
  { level: 7,  name: '복숭아',   radius: 76,  emoji: '🍑', color: '#ffab91' },
  { level: 8,  name: '파인애플', radius: 88,  emoji: '🍍', color: '#fdd835' },
  { level: 9,  name: '멜론',     radius: 100, emoji: '🍈', color: '#9ccc65' },
  { level: 10, name: '수박',     radius: 116, emoji: '🍉', color: '#43a047' },
];

export const LAST_LEVEL = FRUITS.length - 1;
export const MAX_DROP_LEVEL = 4; // 떨어뜨릴 수 있는 최대 단계 (0~4)
// 떨어뜨릴 과일의 가중치 (index = level, 길이 = MAX_DROP_LEVEL + 1)
export const DROP_WEIGHTS = [30, 28, 20, 14, 8];

// 합쳐서 level 과일이 만들어질 때 얻는 점수: 1, 3, 6, 10, ... 66
export const scoreOf = (level) => ((level + 1) * (level + 2)) / 2;
export const WATERMELON_PAIR_BONUS = 100;

export const TIMING = {
  step: 1000 / 60,   // 물리 고정 타임스텝(ms)
  dropCooldown: 500, // 드롭 후 입력 무시 시간
  settleGrace: 1500, // 생성/드롭 직후 게임오버 판정 제외 시간
  overflow: 2000,    // 경계선 위에 연속 체류하면 게임오버가 되는 시간
};

export const PHYSICS = {
  gravityY: 1,
  restitution: 0.1,
  friction: 0.1,
  frictionStatic: 0.5,
};

// Apps Script 웹 앱 배포 URL(…/exec). 빈 문자열이면 오프라인 모드(랭킹 비활성).
export const API_URL = '';

export const NICKNAME_MAX = 12;
export const RANKING_LIMIT = 10;

export const STORAGE_KEYS = {
  best: 'fruit.best',
  nickname: 'fruit.nickname',
  muted: 'fruit.muted',
  pending: 'fruit.pendingScore',
  clientId: 'fruit.clientId',
};
