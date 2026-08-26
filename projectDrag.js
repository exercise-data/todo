// 프로젝트 목록 드래그 컨트롤러 (개인용 / 팀 공용이 함께 쓴다)
//
// projectOrder.js 는 계산만 하는 순수 모듈로 두고(Node 에서 그대로 테스트한다), DOM·포인터를
// 만지는 부분만 이 파일로 분리했다. Firestore 는 여기서도 모른다 — 놓은 자리를 설명하는
// { dragId, toDone, beforeId } 만 만들어 호출부에 넘기고, 저장은 호출부가 한다.
//
// 조작 규칙(간트 막대 드래그와 동일한 관례):
//  - 마우스·펜: 손잡이(⠿)를 누르는 즉시 시작.
//  - 터치: 롱프레스 450ms 후 시작. 대기 중에는 아무것도 억제하지 않아, 손가락을 움직이면
//    그냥 목록이 스크롤된다(오터치 방지). 성사된 뒤에만 스크롤을 막는다.
//  - ⚠ 손잡이에 touch-action 을 주지 않는다. 주면 대기 중 스와이프가 스크롤로 넘어가지 못한다.
//
// 카드 위치는 끄는 동안 DOM 에서 실제로 옮긴다(sortable 방식). 그래서 놓는 순간의
// "앞/뒤 형제"가 곧 결과이고, 구분선을 넘었는지도 형제 관계로 그대로 읽어낼 수 있다.

const LONGPRESS_MS = 450;
const LONGPRESS_CANCEL_PX = 10;

// 드래그 중 자동 스크롤. 없으면 화면 밖으로 옮길 때 여러 번 나눠 끌어야 해서 긴 목록에서
// 사실상 못 쓴다. 터치는 드래그가 성사된 뒤 touchmove 를 막아 네이티브 스크롤이 없으므로,
// 폰에서는 이게 목록 밖으로 나가는 유일한 수단이다.
const EDGE_PX = 48;         // 이 안에 포인터가 들어오면 그쪽으로 굴린다
const SPEED_MIN_PX_S = 120; // 감지 폭의 안쪽 경계에서의 속도
const SPEED_MAX_PX_S = 900; // 끝에 완전히 붙였을 때의 속도
const FRAME_CAP_MS = 50;    // 탭 전환 등으로 프레임 간격이 벌어져도 한 번에 튀지 않게

// 스크롤 주체가 화면 폭에 따라 다르다 — 980px+ 에서는 .pproj-list 자신이 overflow-y:auto 이고,
// ≤979px 에서는 overflow-y:visible 이라 페이지가 스크롤된다(styles.css 반응형 블록).
// 그래서 하나로 못 박지 않고 목록에서 위로 올라가며 후보를 모아 가까운 쪽부터 쓴다.
// 마지막은 항상 페이지. 실제로 굴릴 여지가 있는지는 매 프레임 room() 으로 본다
// (드래그 도중 목록이 길어져 스크롤이 생길 수도 있다).
function scrollableAncestors(startEl) {
  const page = document.scrollingElement || document.documentElement;
  const chain = [];
  for (let el = startEl; el && el !== page; el = el.parentElement) {
    const ov = getComputedStyle(el).overflowY;
    if (ov === "auto" || ov === "scroll" || ov === "overlay") chain.push(elementScroller(el));
  }
  chain.push(pageScroller(page));
  return chain;
}

// dir: -1 위 / +1 아래. by() 는 요청량이 아니라 "실제로 움직인 양"을 돌려준다.
function elementScroller(el) {
  return {
    node: el,
    edges: () => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    },
    room: (dir) => (dir < 0 ? el.scrollTop : el.scrollHeight - el.clientHeight - el.scrollTop),
    by: (dy) => {
      const before = el.scrollTop;
      el.scrollTop = before + dy;
      return el.scrollTop - before;
    },
  };
}

// 페이지는 가장자리 기준이 "요소의 사각형"이 아니라 뷰포트다. 스크롤된 상태에서
// documentElement 의 rect.top 은 음수라, 그대로 쓰면 위쪽 가장자리를 영영 못 만난다.
function pageScroller(page) {
  return {
    node: page,
    // ⚠ 폰에서는 innerHeight 가 "지금 실제로 보이는 높이"와 다를 수 있다(주소창·툴바가
    //   떠 있거나 핀치 확대 중). 그러면 아래쪽 감지 폭(48px)이 툴바 뒤에 숨어 손가락이
    //   닿지 못한다 — 터치에서는 자동 스크롤이 목록 밖으로 나가는 유일한 수단이라 치명적이다.
    //   visualViewport 는 보이는 영역을 그대로 알려준다. clientY 는 레이아웃 뷰포트 기준이고
    //   offsetTop 이 그 안에서의 위치라, 둘을 더하면 좌표계가 맞는다.
    //   (데스크톱에서는 offsetTop=0 · height=innerHeight 라 동작이 달라지지 않는다.)
    edges: () => {
      const vv = window.visualViewport;
      if (vv) return { top: vv.offsetTop, bottom: vv.offsetTop + vv.height };
      return { top: 0, bottom: window.innerHeight || page.clientHeight };
    },
    room: (dir) => (dir < 0 ? page.scrollTop : page.scrollHeight - page.clientHeight - page.scrollTop),
    by: (dy) => {
      const before = page.scrollTop;
      page.scrollTop = before + dy;
      return page.scrollTop - before;
    },
  };
}

// 터치 롱프레스 대기. 임계값 이상 움직이거나 만료 전에 떼면 포기(= 평범한 스크롤/탭).
// personalTasks.js 의 간트용 waitTouchLongPress 와 같은 규칙이지만, 여기서는 세로 이동이
// 중요해 x·y 를 함께 본다. 돌려주는 함수를 부르면 대기를 밖에서 끊을 수 있다.
function waitTouchLongPress(e, onCommit) {
  const pointerId = e.pointerId;
  const downX = e.clientX;
  const downY = e.clientY;
  let lastY = downY; // 대기 중 임계값 안에서 움직였을 수 있다 — 성사 시점의 y 를 쓴다

  const cancelWait = () => {
    clearTimeout(timer);
    document.removeEventListener("pointermove", onWaitMove);
    document.removeEventListener("pointerup", onWaitEnd);
    document.removeEventListener("pointercancel", onWaitEnd);
  };
  const onWaitMove = (ev) => {
    if (ev.pointerId !== pointerId) return;
    lastY = ev.clientY;
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > LONGPRESS_CANCEL_PX) {
      cancelWait(); // 스크롤 의도 — 아무것도 막지 않았으므로 스크롤이 그대로 이어진다
    }
  };
  const onWaitEnd = (ev) => {
    if (ev.pointerId !== pointerId) return;
    cancelWait();
  };
  const timer = setTimeout(() => {
    cancelWait();
    onCommit(pointerId, lastY);
  }, LONGPRESS_MS);

  document.addEventListener("pointermove", onWaitMove);
  document.addEventListener("pointerup", onWaitEnd);
  document.addEventListener("pointercancel", onWaitEnd);
  return cancelWait;
}

// listEl        : .pproj-list (목록 ul)
// isEnabled()   : 지금 드래그를 허용할지 (로그인 상태·수정 중 여부 등)
// onDragStateChange(dragging) : 드래그 시작/종료 알림 — 호출부가 재렌더를 보류하는 데 쓴다
// onDrop({ dragId, toDone, beforeId }) : 실제로 자리가 바뀐 경우에만 호출된다
//
// 반환: { cancel } — 진행 중인 드래그(와 터치 롱프레스 대기)를 저장 없이 끊는다.
//   팀 전환처럼 "지금 보고 있는 목록 자체가 바뀌는" 순간에 부른다. 그대로 두면 드롭이
//   엉뚱한 팀의 캐시로 계산돼 남의 팀 문서를 건드리게 된다.
//   DOM 은 끌던 모습 그대로 두고 onDragStateChange(false) 만 알린다 — 되돌리는 건
//   호출부의 재렌더 몫이다(어차피 목록을 다시 그리는 길목에서 부르게 된다).
export function attachProjectDrag({ listEl, isEnabled, onDragStateChange, onDrop }) {
  let activePointerId = null;
  let draggedEl = null;
  let startNextEl = null; // 시작 시점의 다음 형제 — 놓았을 때 자리가 바뀌었는지 판별
  let blockTouchScroll = null;
  let lastPointerY = 0; // 자동 스크롤이 매 프레임 삽입 위치를 다시 잡는 기준
  let scrollers = [];
  let anchorSaved = [];
  let rafId = 0;
  let lastFrameMs = 0;
  let cancelWaitTouch = null; // 롱프레스 대기 중이면 그 대기를 끊는 함수

  listEl.addEventListener("pointerdown", (e) => {
    if (activePointerId !== null) return; // 이미 하나 끌고 있음(멀티터치 방지)
    const handle = e.target.closest(".pproj-drag-handle");
    if (!handle) return;
    const li = handle.closest(".pproj-item");
    if (!li || (isEnabled && !isEnabled())) return;

    if (e.pointerType !== "touch") {
      e.preventDefault(); // 텍스트 선택 방지
      start(li, e.pointerId, false, e.clientY);
      return;
    }
    cancelWaitTouch = waitTouchLongPress(e, (pointerId, y) => {
      cancelWaitTouch = null;
      start(li, pointerId, true, y);
    });
  });

  function start(li, pointerId, isTouch, pointerY) {
    if (activePointerId !== null || !li.isConnected) return;
    activePointerId = pointerId;
    draggedEl = li;
    startNextEl = li.nextElementSibling;
    lastPointerY = pointerY;
    scrollers = scrollableAncestors(listEl);
    suppressScrollAnchor();

    try {
      listEl.setPointerCapture(pointerId);
    } catch {}
    li.classList.add("is-dragging");
    listEl.classList.add("is-dragging");
    document.body.style.userSelect = "none";

    // 스크롤 억제는 '롱프레스 성사 후'에만 (대기 중엔 걸지 않는다 — 간트와 같은 규칙)
    if (isTouch) {
      blockTouchScroll = (ev) => ev.preventDefault();
      document.addEventListener("touchmove", blockTouchScroll, { passive: false });
      if (navigator.vibrate) navigator.vibrate(15); // 성사 피드백(지원 기기)
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);

    if (onDragStateChange) onDragStateChange(true);
    paintZone();
  }

  // 포인터 y 가 어느 행의 위쪽 절반에 있는지로 삽입 위치를 정한다.
  // 구분선·안내 박스·"없습니다" 줄도 그대로 한 행으로 취급하므로, 구분선을 넘는 것이
  // 자연스럽게 "완료 영역으로 옮기기"가 된다.
  function findInsertRef(y) {
    for (const el of listEl.children) {
      if (el === draggedEl) continue;
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) return el;
    }
    return null; // 맨 뒤
  }

  // 포인터 이동으로도, 자동 스크롤로도 같은 계산을 한다 — 그래서 따로 뺐다.
  function applyMoveAt(y) {
    if (!draggedEl || !draggedEl.isConnected) return;
    const ref = findInsertRef(y);
    if (ref !== draggedEl && ref !== draggedEl.nextElementSibling) {
      listEl.insertBefore(draggedEl, ref);
    }
    paintZone();
  }

  function onMove(ev) {
    if (ev.pointerId !== activePointerId || !draggedEl) return;
    if (!draggedEl.isConnected) {
      // 재렌더 보류가 어딘가에서 풀려 카드가 사라진 경우 — 조용히 끝낸다
      finish(false);
      return;
    }
    lastPointerY = ev.clientY;
    applyMoveAt(lastPointerY);
    ensureAutoScroll();
  }

  // 지금 어느 스크롤러를 어느 방향으로 얼마나 빨리 굴릴지. 가장자리 밖이면 null.
  // 가까운 스크롤러가 그 방향으로 끝까지 갔으면 다음(결국 페이지)으로 넘긴다.
  function pickScroll() {
    for (const s of scrollers) {
      const { top, bottom } = s.edges();
      const upDist = lastPointerY - top;
      const downDist = bottom - lastPointerY;
      const dir = upDist < downDist ? -1 : 1;
      const dist = dir < 0 ? upDist : downDist;
      if (dist >= EDGE_PX) continue; // 가장자리 근처가 아니다
      if (s.room(dir) <= 0) continue; // 그쪽으로 더 갈 데가 없다
      // 밖으로 완전히 벗어나면 dist 가 음수 — 그때는 최고 속도로 고정된다
      const ratio = Math.min(1, Math.max(0, (EDGE_PX - dist) / EDGE_PX));
      return { s, dir, speed: SPEED_MIN_PX_S + (SPEED_MAX_PX_S - SPEED_MIN_PX_S) * ratio };
    }
    return null;
  }

  // 가장자리 안이면 루프를 켠다. 손가락이 멈춰 있어도 계속 굴러야 하므로 루프가 스스로
  // 다음 프레임을 잡고, 가장자리를 벗어나면(pickScroll 이 null) 그 프레임에 멈춘다.
  // ⚠ 드래그 시작 시점에는 부르지 않는다 — 목록 맨 위/아래 카드는 손잡이가 이미 가장자리
  //   안이라, 손도 안 움직였는데 화면이 흐르기 시작한다.
  function ensureAutoScroll() {
    if (rafId || !draggedEl) return;
    if (!pickScroll()) return;
    lastFrameMs = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function tick(now) {
    rafId = 0;
    if (!draggedEl || !draggedEl.isConnected) return;
    const pick = pickScroll();
    if (!pick) return;
    const dt = Math.min(FRAME_CAP_MS, Math.max(0, now - lastFrameMs)) / 1000;
    lastFrameMs = now;
    const moved = pick.s.by(pick.dir * pick.speed * dt);
    // ⚠ 핵심: 스크롤하면 카드들이 "가만히 있는 포인터" 아래에서 움직인다. 기억해 둔 y 로
    //   삽입 위치를 매 프레임 다시 잡지 않으면 화면만 흐르고 카드는 제자리에 남는다.
    if (moved) applyMoveAt(lastPointerY);
    rafId = requestAnimationFrame(tick);
  }

  // ⚠ 드래그 동안 스크롤 앵커링(overflow-anchor)을 꺼 둔다.
  //   카드를 화면 위쪽 밖으로 옮기면 브라우저가 "보이던 내용을 제자리에 두려고" scrollTop 을
  //   카드 높이만큼 되돌린다. 그래서 자동 스크롤이 제 속도의 절반도 못 내고 맨 위에 닿지도
  //   못한다(하네스 측정: 위로 1.2초에 948px 갈 것이 457px). 드롭 후 원래 값으로 되돌린다.
  function suppressScrollAnchor() {
    anchorSaved = scrollers.map((s) => [s.node, s.node.style.overflowAnchor]);
    anchorSaved.forEach(([node]) => {
      node.style.overflowAnchor = "none";
    });
  }

  function restoreScrollAnchor() {
    anchorSaved.forEach(([node, prev]) => {
      node.style.overflowAnchor = prev;
    });
    anchorSaved = [];
  }

  function stopAutoScroll() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    restoreScrollAnchor();
    scrollers = [];
  }

  // 완료 영역에 들어와 있으면 구분선/안내 박스를 강조
  function paintZone() {
    const toDone = draggedEl ? isAfterDivider(draggedEl) : false;
    listEl.querySelectorAll(".pproj-divider, .pproj-done-hint").forEach((el) => {
      el.classList.toggle("is-drop-active", toDone);
    });
  }

  function isAfterDivider(el) {
    const rows = [...listEl.children];
    const div = rows.findIndex((r) => r.classList.contains("pproj-divider"));
    return div !== -1 && rows.indexOf(el) > div;
  }

  // 놓은 자리를 computeDrop 이 그대로 쓰는 형태로 옮긴다.
  // beforeId = 같은 영역에서 바로 뒤에 오는 카드의 id. 영역의 맨 끝이면 null.
  function describeDrop() {
    const rows = [...listEl.children];
    const dragIdx = rows.indexOf(draggedEl);
    let beforeId = null;
    for (let i = dragIdx + 1; i < rows.length; i++) {
      const el = rows[i];
      if (el.classList.contains("pproj-divider")) break; // 진행 중 영역이 여기서 끝난다
      if (el.classList.contains("pproj-item")) {
        beforeId = el.dataset.id;
        break;
      }
    }
    return { dragId: draggedEl.dataset.id, toDone: isAfterDivider(draggedEl), beforeId };
  }

  function onEnd(ev) {
    if (ev.pointerId !== activePointerId) return;
    finish(true);
  }

  function finish(commit) {
    stopAutoScroll();
    const el = draggedEl;
    const moved = !!el && el.isConnected && el.nextElementSibling !== startNextEl;
    const drop = commit && moved ? describeDrop() : null;

    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onEnd);
    document.removeEventListener("pointercancel", onEnd);
    if (blockTouchScroll) {
      document.removeEventListener("touchmove", blockTouchScroll);
      blockTouchScroll = null;
    }
    try {
      listEl.releasePointerCapture(activePointerId);
    } catch {}

    if (el) el.classList.remove("is-dragging");
    listEl.classList.remove("is-dragging");
    listEl.querySelectorAll(".is-drop-active").forEach((n) => n.classList.remove("is-drop-active"));
    document.body.style.userSelect = "";

    activePointerId = null;
    draggedEl = null;
    startNextEl = null;

    // ⚠ 순서가 중요하다: 먼저 '드래그 끝'을 알려 호출부의 재렌더 보류를 풀고, 그 다음 onDrop.
    //   반대로 하면 onDrop 안에서 부른 렌더가 보류에 걸려 화면이 갱신되지 않는다.
    if (onDragStateChange) onDragStateChange(false);
    if (drop && onDrop) onDrop(drop);
  }

  return {
    cancel() {
      if (cancelWaitTouch) {
        cancelWaitTouch();
        cancelWaitTouch = null;
      }
      if (activePointerId !== null) finish(false); // commit=false → onDrop 을 부르지 않는다
    },
  };
}
