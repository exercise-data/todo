// 프로젝트 정렬·드래그 공용 모듈 (개인용 / 팀 공용 양쪽이 함께 쓴다)
//
// 개인(personalProjects.js)·팀(teamProjects.js)은 코드 복제 구조지만, 순서 계산과 포인터
// 드래그까지 복제하면 양쪽이 어긋날 위험이 커서 이 부분만 공유 모듈로 뺐다.
// Firebase 도 DOM 도 import 하지 않는 순수 모듈이라 Node 에서 그대로 유닛 테스트할 수 있다.
// (브라우저에서는 두 모듈이 import 하므로 index.html 에 <script> 를 따로 넣지 않는다)
//
// 프로젝트 문서에 추가되는 필드는 둘뿐:
//   done  (bool)   — 목록 하단 '완료' 영역에 있는가. 없으면 진행 중.
//   order (number) — 같은 영역 안에서의 위치. 없으면 createdAt 순(= 붙이기 전 동작).
// 두 필드가 모두 없는 기존 문서는 "진행 중 · createdAt 오름차순" 으로 정렬되어
// 이 모듈을 붙이기 전과 순서가 완전히 같다 → 마이그레이션·백필 불필요.

// 완료 영역에 있는가. 명시적으로 true 일 때만 완료로 본다
// (undefined·null·문자열 등 옛 데이터/오타 값은 전부 진행 중으로 취급).
export function isDone(p) {
  return p && p.done === true;
}

// 정렬용 order 값. 없거나 숫자가 아니면 Infinity → 같은 영역의 맨 뒤로 밀린다.
export function orderOf(p) {
  const v = p ? p.order : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : Infinity;
}

// createdAt(Firestore Timestamp) → millis. 없으면 Infinity(= 맨 뒤).
// serverTimestamp() 가 서버에서 확정되기 전 로컬 스냅샷에서는 null 이라 잠시 맨 뒤에 온다
// (기존 personalProjects/teamProjects 의 createdMillis 와 동일한 동작).
export function createdMillis(p) {
  const ts = p ? p.createdAt : null;
  if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts === "number" && Number.isFinite(ts)) return ts; // 테스트/가져오기용 millis
  return Infinity;
}

// 목록 정렬 기준: 진행 중 먼저 → order → createdAt → id.
// ⚠ 마지막 id 비교가 핵심이다. 값이 모두 같을 때 정렬을 '결정적'으로 만들어,
//   여러 기기에서 같은 데이터가 항상 같은 순서로 보이게 한다(동률 흔들림 방지).
// ⚠ Infinity - Infinity = NaN 이라 뺄셈으로 비교하지 않고 !== 로 먼저 걸러낸다.
export function compareProjects(a, b) {
  const da = isDone(a) ? 1 : 0;
  const db = isDone(b) ? 1 : 0;
  if (da !== db) return da - db;

  const oa = orderOf(a);
  const ob = orderOf(b);
  if (oa !== ob) return oa < ob ? -1 : 1;

  const ca = createdMillis(a);
  const cb = createdMillis(b);
  if (ca !== cb) return ca < cb ? -1 : 1;

  const ia = a && a.id != null ? String(a.id) : "";
  const ib = b && b.id != null ? String(b.id) : "";
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

// 원본을 건드리지 않고 정렬한 새 배열을 돌려준다(호출부는 이것만 쓰면 된다).
export function sortProjects(list) {
  return (list || []).slice().sort(compareProjects);
}

// ----- 백업/복원용 -----
// 이미 "표시 순서대로" 늘어선 배열에 영역별 order(0..n-1)를 매기고 done 을 boolean 으로
// 정규화한다. 원본은 건드리지 않는다.
//
// 내보내기와 가져오기가 **같은 함수**를 쓰는 것이 요점이다. 백업의 약속은 하나 —
// **"배열 순서가 곧 표시 순서"**. 내보낼 때는 sortProjects 로 정렬한 뒤 이 함수로 번호를
// 매기고, 가져올 때는 파일의 배열 순서 그대로 이 함수로 번호를 매긴다. 두 쪽이 서로 다른
// 규칙을 쓰면 내보내고 다시 가져올 때마다 순서가 조금씩 흔들린다.
//
// 옛 백업 파일(두 필드가 아예 없음)은 자연히 "전부 진행 중 · order = 배열 인덱스" 가 된다
// — 옛 내보내기가 createdAt 순으로 저장했으므로 그때 보이던 순서가 그대로 살아난다.
export function assignSectionOrder(list) {
  let active = 0;
  let done = 0;
  return (list || []).map((p) => {
    const d = isDone(p);
    return { ...p, done: d, order: d ? done++ : active++ };
  });
}

// ----- 드롭 계산 -----
// 드래그를 놓은 순간, 어떤 문서의 어떤 필드를 어떤 값으로 써야 하는지만 계산한다.
// DOM 도 Firestore 도 모르는 순수 함수라 그대로 유닛 테스트할 수 있다.
//
//   scope   : 그 영역의 프로젝트 전체(개인 전체 / 그 팀 전체). **필터로 거르기 전** 목록이어야 한다.
//             숨겨진 항목까지 넘겨야 그들의 상대 순서를 지킬 수 있다.
//   dragId  : 끌고 있던 프로젝트 id
//   toDone  : 놓은 자리가 구분선 아래(완료)인가
//   beforeId: 놓은 자리 바로 '뒤'에 오는 **보이는** 항목의 id. 맨 끝에 놓았으면 null.
//             (DOM 자리표시자 기준으로 "이 항목 앞에 끼운다" 를 그대로 넘기면 된다 — 인덱스 계산 불필요)
//
// 반환: [{ id, done, order }] — **값이 실제로 바뀌는 문서만**. 바뀔 게 없으면 빈 배열.
//
// 숨은 항목 처리(핵심): 삽입 위치를 '보이는 이웃(beforeId)' 기준으로 잡되, 실제 삽입은
// 숨은 항목까지 포함한 전체 목록에서 그 이웃의 자리에 한다. 그래서 필터를 켠 채 옮겨도
// 숨어 있던 항목들의 상대 순서가 그대로 유지된다.
//
// order 값은 매번 각 영역 안에서 0,1,2… 로 촘촘히 다시 매긴다(정규화).
// - 필드가 없던 기존 문서도 첫 드롭 때 한 번에 정상 값을 갖는다(백필 불필요).
// - 여러 기기가 동시에 옮겨 값이 꼬여도 다음 드롭에서 다시 수렴한다.
// - 대신 위로 크게 옮기면 그 사이 문서 수만큼 쓰기가 생긴다(프로젝트 목록 규모에선 문제없음).
export function computeDrop(scope, { dragId, toDone, beforeId } = {}) {
  const all = sortProjects(scope).filter((p) => p && p.id != null);
  const dragged = all.find((p) => p.id === dragId);
  if (!dragged) return []; // 이미 삭제됐거나 잘못된 id — 아무것도 하지 않는다
  // "자기 앞에 놓기" 는 뜻이 모호하다. 맨 뒤로 밀어버리면 사용자가 의도하지 않은 이동이 되므로
  // 아무 일도 하지 않는 쪽을 택한다(정상 드래그에서는 나올 수 없는 입력 — 방어용).
  if (beforeId === dragId) return [];

  // 끌던 항목을 빼고 두 영역으로 나눈다(순서는 sortProjects 결과 그대로).
  const active = [];
  const done = [];
  all.forEach((p) => {
    if (p.id === dragId) return;
    (isDone(p) ? done : active).push(p);
  });

  const target = toDone === true ? done : active;

  // beforeId 가 그 영역의 항목이면 그 앞에, 아니면(맨 끝/다른 영역/사라진 id) 맨 뒤에 끼운다.
  let at = target.length;
  if (beforeId != null) {
    const i = target.findIndex((p) => p.id === beforeId);
    if (i !== -1) at = i;
  }
  target.splice(at, 0, dragged);

  // 두 영역 각각 0..n-1 로 다시 매기고, 지금 값과 다른 문서만 쓰기 목록에 담는다.
  const writes = [];
  const collect = (list, doneFlag) => {
    list.forEach((p, i) => {
      if (isDone(p) === doneFlag && orderOf(p) === i) return; // 이미 같은 값 → 쓰지 않음
      writes.push({ id: p.id, done: doneFlag, order: i });
    });
  };
  collect(active, false);
  collect(done, true);
  return writes;
}

// computeDrop 의 결과를 목록에 미리 반영한 새 배열을 만든다(원본은 그대로).
// 저장이 끝나기 전에 화면을 먼저 새 순서로 그리는 '낙관적 반영'과, 유닛 테스트에서 쓴다.
export function applyWrites(list, writes) {
  const byId = new Map((writes || []).map((w) => [w.id, w]));
  return (list || []).map((p) => (byId.has(p.id) ? { ...p, ...byId.get(p.id) } : p));
}

// 문서 하나에 실제로 기록할 필드를 정한다.
// doneAt 은 **완료 여부가 바뀐 문서에만** 넣는다 — 순서를 바꿀 때마다 덮어쓰면
// 처음 완료한 시각이 매번 사라진다.
// stamp: 서버 시각 값(Firestore 의 serverTimestamp()). 이 모듈은 Firestore 를 모르므로 주입받는다.
export function orderWriteFields(write, wasDone, stamp) {
  const data = { done: write.done, order: write.order };
  if (wasDone !== write.done) data.doneAt = write.done ? stamp : null;
  return data;
}
