// 입력: 포인터(마우스/터치/펜) + 키보드. 입력을 '조준 x 갱신'과 '드롭 요청'으로만 바꾼다.
// 게임 상태(쿨다운 등)는 모른다 — 드롭이 가능한지는 onDrop 을 받은 쪽이 결정한다.

const KEY_SPEED = 320; // 방향키 이동 속도 (논리 px / 초)

const hasTag = (el, ...tags) => !!el && tags.includes(el.tagName);

// 글자를 입력하는 요소: 방향키/스페이스가 입력용으로 쓰인다.
function isTextEntry(el) {
  return hasTag(el, 'INPUT', 'TEXTAREA', 'SELECT') || !!el?.isContentEditable;
}

// 스페이스로 '활성화'되는 요소: 여기서 스페이스를 가로채면 접근성이 깨진다.
function isActivatable(el) {
  return (
    isTextEntry(el) ||
    hasTag(el, 'BUTTON', 'A', 'SUMMARY') ||
    el?.getAttribute?.('role') === 'button'
  );
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas
 * @param {(clientX:number, clientY:number) => {x:number, y:number}} o.clientToWorld
 * @param {() => number} o.getAimX          현재 조준 x (방향키 이동의 기준)
 * @param {(x:number) => void} o.onAim      조준 x 가 바뀜 (범위 보정은 받는 쪽에서)
 * @param {() => void} o.onDrop             드롭 요청
 * @param {() => boolean} [o.isBlocked]     오버레이가 떠 있는 등 입력을 막아야 할 때 true
 * @param {EventTarget} [o.keyTarget]       키보드 이벤트를 받을 대상 (기본 window)
 */
export function createInput({
  canvas,
  clientToWorld,
  getAimX,
  onAim,
  onDrop,
  isBlocked = () => false,
  keyTarget = globalThis.window,
}) {
  let activePointerId = null; // 캔버스를 누르고 있는 포인터
  const held = { left: false, right: false };

  canvas.style.touchAction = 'none'; // CSS 와 별개로 한 번 더 (스크롤/확대 방지)

  const aimFrom = (e) => onAim(clientToWorld(e.clientX, e.clientY).x);

  function releaseCapture(pointerId) {
    try {
      if (canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId);
    } catch {
      // 이미 해제됨
    }
  }

  function onPointerDown(e) {
    if (!e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (isBlocked()) return;
    activePointerId = e.pointerId;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // 캡처에 실패해도 캔버스 안에서는 계속 동작한다
    }
    aimFrom(e);
  }

  function onPointerMove(e) {
    if (!e.isPrimary || isBlocked()) return;
    const pressed = e.pointerId === activePointerId;
    // 마우스/펜은 누르지 않고 움직여도 조준한다. 터치는 누르고 있을 때만 이벤트가 온다.
    if (pressed || (activePointerId === null && e.pointerType !== 'touch')) aimFrom(e);
  }

  function onPointerUp(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    releaseCapture(e.pointerId);
    if (isBlocked()) return; // 누르는 사이에 오버레이가 떴다면 드롭하지 않는다
    aimFrom(e);
    onDrop();
  }

  function onPointerCancel(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    releaseCapture(e.pointerId);
  }

  function onLostCapture(e) {
    if (e.pointerId === activePointerId) activePointerId = null;
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (isTextEntry(e.target) || isBlocked()) return;
      held[e.key === 'ArrowLeft' ? 'left' : 'right'] = true;
      e.preventDefault();
    } else if (e.code === 'Space' || e.key === ' ') {
      if (isActivatable(e.target)) return;
      e.preventDefault(); // 페이지 스크롤 방지 (오버레이가 떠 있어도 마찬가지)
      if (e.repeat || isBlocked()) return;
      onDrop();
    }
  }

  function onKeyUp(e) {
    if (e.key === 'ArrowLeft') held.left = false;
    else if (e.key === 'ArrowRight') held.right = false;
  }

  function clearKeys() {
    held.left = false;
    held.right = false;
  }

  function onContextMenu(e) {
    e.preventDefault();
  }

  const canvasListeners = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerCancel],
    ['lostpointercapture', onLostCapture],
    ['contextmenu', onContextMenu],
  ];
  const keyListeners = [
    ['keydown', onKeyDown],
    ['keyup', onKeyUp],
    ['blur', clearKeys],
  ];
  for (const [type, fn] of canvasListeners) canvas.addEventListener(type, fn);
  for (const [type, fn] of keyListeners) keyTarget?.addEventListener(type, fn);

  // 매 프레임 호출: 방향키를 누르고 있는 동안 연속 이동
  function update(dtMs) {
    if (isBlocked()) {
      clearKeys();
      return;
    }
    const dir = (held.right ? 1 : 0) - (held.left ? 1 : 0);
    if (dir !== 0) onAim(getAimX() + (dir * KEY_SPEED * dtMs) / 1000);
  }

  function destroy() {
    for (const [type, fn] of canvasListeners) canvas.removeEventListener(type, fn);
    for (const [type, fn] of keyListeners) keyTarget?.removeEventListener(type, fn);
    if (activePointerId !== null) releaseCapture(activePointerId);
    activePointerId = null;
    clearKeys();
  }

  return { update, destroy };
}
