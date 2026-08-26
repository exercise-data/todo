// projectOrder.js 유닛 테스트 — `node --test` 로 실행한다.
//
// 이 파일은 앱이 로드하지 않는다(index.html 과 무관). Firebase·DOM 없이 순수 계산만 검증하므로
// 로그인 없이도 순서/완료 규칙이 깨지지 않았는지 언제든 확인할 수 있다.

import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDrop,
  sortProjects,
  isDone,
  orderOf,
  applyWrites,
  orderWriteFields,
  assignSectionOrder,
} from "./projectOrder.js";

// 쓰기 목록을 원본에 반영(= Firestore 가 하는 일). 앱의 낙관적 반영과 같은 함수를 쓴다.
const apply = applyWrites;

// 최종 표시 순서를 "진행중|완료" 문자열로 (읽기 쉬운 단언용)
function seq(scope) {
  const s = sortProjects(scope);
  return (
    s.filter((p) => !isDone(p)).map((p) => p.id).join(",") +
    "|" +
    s.filter((p) => isDone(p)).map((p) => p.id).join(",")
  );
}

// 드롭 후 상태를 한 번에
function drop(scope, opts) {
  const writes = computeDrop(scope, opts);
  return { writes, after: apply(scope, writes), seq: seq(apply(scope, writes)) };
}

// 각 영역의 order 가 0..n-1 로 촘촘한지
function assertDense(scope, label) {
  const s = sortProjects(scope);
  for (const flag of [false, true]) {
    const group = s.filter((p) => isDone(p) === flag);
    group.forEach((p, i) => {
      assert.equal(orderOf(p), i, `${label}: ${p.id} 의 order 가 ${i} 여야 함`);
    });
  }
}

// 이미 정규화된(order 0,1,2…) 진행 중 3개
const abc = () => [
  { id: "a", order: 0 },
  { id: "b", order: 1 },
  { id: "c", order: 2 },
];

test("같은 영역 안에서 아래로 이동", () => {
  const r = drop(abc(), { dragId: "a", toDone: false, beforeId: "c" });
  assert.equal(r.seq, "b,a,c|");
  assertDense(r.after, "아래로");
});

test("같은 영역 안에서 위로 이동", () => {
  const r = drop(abc(), { dragId: "c", toDone: false, beforeId: "a" });
  assert.equal(r.seq, "c,a,b|");
  assertDense(r.after, "위로");
});

test("맨 끝으로 이동 (beforeId=null)", () => {
  const r = drop(abc(), { dragId: "a", toDone: false, beforeId: null });
  assert.equal(r.seq, "b,c,a|");
});

test("구분선 넘기: 진행 중 → 완료 (완료 영역이 비어 있던 첫 진입)", () => {
  const r = drop(abc(), { dragId: "b", toDone: true, beforeId: null });
  assert.equal(r.seq, "a,c|b");
  assert.deepEqual(
    r.writes.find((w) => w.id === "b"),
    { id: "b", done: true, order: 0 }
  );
  assertDense(r.after, "완료로");
});

test("구분선 넘기: 완료 → 진행 중 (원하는 위치로 복귀)", () => {
  const scope = [
    { id: "a", order: 0 },
    { id: "b", order: 1 },
    { id: "x", order: 0, done: true },
  ];
  const r = drop(scope, { dragId: "x", toDone: false, beforeId: "b" });
  assert.equal(r.seq, "a,x,b|");
  assert.equal(r.writes.find((w) => w.id === "x").done, false);
});

test("완료 영역 안에서의 재정렬", () => {
  const scope = [
    { id: "a", order: 0 },
    { id: "x", order: 0, done: true },
    { id: "y", order: 1, done: true },
    { id: "z", order: 2, done: true },
  ];
  const r = drop(scope, { dragId: "z", toDone: true, beforeId: "x" });
  assert.equal(r.seq, "a|z,x,y");
});

test("필터 켜짐: 숨은 항목의 상대 순서가 보존된다", () => {
  // 화면에는 a,b 만 보이고 h 는 다른 카테고리라 숨어 있음(scope 에는 반드시 포함해 넘긴다)
  const scope = [
    { id: "a", order: 0 },
    { id: "h", order: 1 }, // 숨김
    { id: "b", order: 2 },
  ];
  const r = drop(scope, { dragId: "b", toDone: false, beforeId: "a" });
  assert.equal(r.seq, "b,a,h|"); // a→h 순서 그대로, b 만 앞으로
});

test("필터 켜짐: 맨 끝으로 놓으면 숨은 항목 뒤에 붙는다", () => {
  const scope = [
    { id: "a", order: 0 },
    { id: "h", order: 1 }, // 숨김
    { id: "b", order: 2 },
  ];
  const r = drop(scope, { dragId: "a", toDone: false, beforeId: null });
  assert.equal(r.seq, "h,b,a|");
});

test("레거시(order·done 필드 전무): 첫 드롭에서 전체가 정규화된다", () => {
  const scope = [
    { id: "a", createdAt: 100 },
    { id: "b", createdAt: 200 },
    { id: "c", createdAt: 300 },
  ];
  const r = drop(scope, { dragId: "c", toDone: false, beforeId: "a" });
  assert.equal(r.seq, "c,a,b|");
  assert.equal(r.writes.length, 3, "세 문서 모두 order 를 갖게 된다");
  assertDense(r.after, "레거시 정규화");
});

test("제자리 드롭(이미 정규화됨) → 쓰기 없음", () => {
  const r = drop(abc(), { dragId: "b", toDone: false, beforeId: "c" });
  assert.deepEqual(r.writes, []);
  assert.equal(r.seq, "a,b,c|");
});

test("제자리 드롭(레거시) → 순서는 그대로, 값만 정규화", () => {
  const scope = [
    { id: "a", createdAt: 100 },
    { id: "b", createdAt: 200 },
  ];
  const r = drop(scope, { dragId: "a", toDone: false, beforeId: "b" });
  assert.equal(r.seq, "a,b|");
  assert.equal(r.writes.length, 2);
});

test("바뀌지 않는 문서는 쓰기 목록에 넣지 않는다", () => {
  const scope = [
    { id: "a", order: 0 },
    { id: "b", order: 1 },
    { id: "c", order: 2 },
    { id: "d", order: 3 },
  ];
  // c 를 d 앞(= 제자리) 이 아니라 b 앞으로 → a 는 그대로, b·c 만 바뀐다
  const r = drop(scope, { dragId: "c", toDone: false, beforeId: "b" });
  assert.equal(r.seq, "a,c,b,d|");
  assert.deepEqual(r.writes.map((w) => w.id).sort(), ["b", "c"]);
});

test("항목이 하나뿐일 때 완료로 옮기기", () => {
  const r = drop([{ id: "a", order: 0 }], { dragId: "a", toDone: true, beforeId: null });
  assert.equal(r.seq, "|a");
  assert.deepEqual(r.writes, [{ id: "a", done: true, order: 0 }]);
});

test("order 값이 중복·비어 있어도 결과는 촘촘해진다", () => {
  const scope = [
    { id: "a", order: 5, createdAt: 100 },
    { id: "b", order: 5, createdAt: 200 }, // 중복
    { id: "c", createdAt: 300 }, // 없음
  ];
  const r = drop(scope, { dragId: "c", toDone: false, beforeId: "b" });
  assert.equal(r.seq, "a,c,b|");
  assertDense(r.after, "중복 정리");
});

test("없는 id 를 끌면 아무것도 하지 않는다", () => {
  assert.deepEqual(computeDrop(abc(), { dragId: "없음", toDone: false, beforeId: "a" }), []);
});

test("beforeId 가 자기 자신이면 아무것도 하지 않는다", () => {
  // "자기 앞에 놓기" 는 뜻이 모호하다. 맨 뒤로 밀면 의도하지 않은 이동이 되므로 무동작이 안전하다.
  const r = drop(abc(), { dragId: "b", toDone: false, beforeId: "b" });
  assert.deepEqual(r.writes, []);
  assert.equal(r.seq, "a,b,c|");
});

test("beforeId 가 다른 영역 항목이면 무시하고 맨 뒤에 붙인다", () => {
  const scope = [
    { id: "a", order: 0 },
    { id: "b", order: 1 },
    { id: "x", order: 0, done: true },
  ];
  const r = drop(scope, { dragId: "a", toDone: false, beforeId: "x" });
  assert.equal(r.seq, "b,a|x");
});

test("빈 scope·잘못된 인자에도 예외를 던지지 않는다", () => {
  assert.deepEqual(computeDrop([], { dragId: "a", toDone: false, beforeId: null }), []);
  assert.deepEqual(computeDrop(null, {}), []);
  assert.deepEqual(computeDrop(abc()), []);
});

test("done 이 true 가 아닌 값(옛 데이터·오타)은 진행 중으로 다룬다", () => {
  const scope = [
    { id: "a", order: 0, done: "true" },
    { id: "b", order: 1, done: null },
  ];
  const r = drop(scope, { dragId: "b", toDone: false, beforeId: "a" });
  assert.equal(r.seq, "b,a|");
});

test("applyWrites: 원본을 바꾸지 않고 새 배열을 만든다", () => {
  const src = [{ id: "a", order: 0 }, { id: "b", order: 1 }];
  const out = applyWrites(src, [{ id: "b", done: true, order: 0 }]);
  assert.equal(src[1].done, undefined, "원본은 그대로");
  assert.deepEqual(out[1], { id: "b", done: true, order: 0 });
  assert.equal(out[0], src[0], "바뀌지 않는 항목은 그대로 재사용");
});

test("applyWrites: 빈 쓰기·잘못된 인자에도 안전하다", () => {
  assert.deepEqual(applyWrites([{ id: "a" }], []), [{ id: "a" }]);
  assert.deepEqual(applyWrites(null, null), []);
});

test("orderWriteFields: 완료 여부가 그대로면 doneAt 을 건드리지 않는다", () => {
  // 순서만 바꾼 경우 — 처음 완료한 시각이 보존돼야 한다
  assert.deepEqual(orderWriteFields({ id: "a", done: true, order: 2 }, true, "STAMP"), {
    done: true,
    order: 2,
  });
  assert.deepEqual(orderWriteFields({ id: "a", done: false, order: 0 }, false, "STAMP"), {
    done: false,
    order: 0,
  });
});

test("orderWriteFields: 완료로 바뀌면 doneAt 에 서버 시각을 쓴다", () => {
  assert.deepEqual(orderWriteFields({ id: "a", done: true, order: 0 }, false, "STAMP"), {
    done: true,
    order: 0,
    doneAt: "STAMP",
  });
});

test("orderWriteFields: 진행 중으로 되돌리면 doneAt 을 지운다(null)", () => {
  assert.deepEqual(orderWriteFields({ id: "a", done: false, order: 1 }, true, "STAMP"), {
    done: false,
    order: 1,
    doneAt: null,
  });
});

test("orderWriteFields: 이전 상태를 모르면(undefined) 바뀐 것으로 보고 doneAt 을 정리한다", () => {
  assert.deepEqual(orderWriteFields({ id: "a", done: false, order: 0 }, undefined, "STAMP"), {
    done: false,
    order: 0,
    doneAt: null,
  });
});

// ----- 7단계: 백업/복원 순서 규칙 (assignSectionOrder) -----
// 약속은 하나 — "배열 순서가 곧 표시 순서". 내보내기와 가져오기가 이 함수를 함께 쓴다.

// 읽기 쉬운 단언용: [{id, done, order}] → "a#0,*b#0" (앞의 * 가 완료)
const marks = (list) =>
  list.map((p) => (p.done ? "*" : "") + p.id + "#" + p.order).join(",");

test("assignSectionOrder: 옛 백업(두 필드 없음)은 전부 진행 중 · order = 배열 인덱스", () => {
  const old = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(marks(assignSectionOrder(old)), "a#0,b#1,c#2");
});

test("assignSectionOrder: 두 영역에 각각 0..n-1 을 매기고 상대 순서를 지킨다", () => {
  const list = [
    { id: "a" },
    { id: "b", done: true },
    { id: "c" },
    { id: "d", done: true },
  ];
  assert.equal(marks(assignSectionOrder(list)), "a#0,*b#0,c#1,*d#1");
});

test("assignSectionOrder: done 이 true 가 아닌 값은 진행 중으로 정규화된다", () => {
  const list = [{ id: "a", done: "true" }, { id: "b", done: 1 }, { id: "c", done: null }];
  assert.equal(marks(assignSectionOrder(list)), "a#0,b#1,c#2");
});

test("assignSectionOrder: 원본을 바꾸지 않는다", () => {
  const list = [{ id: "a", order: 9 }, { id: "b", done: true, order: 9 }];
  const before = JSON.stringify(list);
  assignSectionOrder(list);
  assert.equal(JSON.stringify(list), before);
});

test("assignSectionOrder: 빈 배열·잘못된 인자에도 안전하다", () => {
  assert.deepEqual(assignSectionOrder([]), []);
  assert.deepEqual(assignSectionOrder(null), []);
  assert.deepEqual(assignSectionOrder(undefined), []);
});

test("assignSectionOrder: 이미 번호가 매겨진 목록에 다시 걸어도 그대로다(멱등)", () => {
  const once = assignSectionOrder([{ id: "a" }, { id: "b", done: true }, { id: "c" }]);
  assert.equal(marks(assignSectionOrder(once)), marks(once));
});

// 백업 왕복(export → import)에서 순서가 흔들리지 않는가.
// 내보내기는 sortProjects 로 정렬한 뒤 번호를 매기고, 가져오기는 그 배열 순서 그대로 번호를
// 매긴다. 그래서 두 번째 왕복부터는 값이 완전히 고정돼야 한다.
test("백업 왕복: 내보낸 배열을 그대로 가져와도 순서가 그대로다", () => {
  const stored = [
    { id: "c", order: 1, createdAt: 300 },
    { id: "a", order: 0, createdAt: 100 },
    { id: "z", done: true, order: 0, createdAt: 200 },
    { id: "b", createdAt: 50 }, // order 없음 — 진행 중 영역 맨 뒤
  ];
  const exported = assignSectionOrder(sortProjects(stored)); // 내보내기가 하는 일
  assert.equal(marks(exported), "a#0,c#1,b#2,*z#0");

  const imported = assignSectionOrder(exported); // 가져오기가 하는 일(배열 순서 그대로)
  assert.equal(marks(imported), marks(exported));

  // 가져온 결과를 다시 내보내도 같아야 한다(정렬을 한 번 더 거쳐도 흔들림 없음)
  assert.equal(marks(assignSectionOrder(sortProjects(imported))), marks(exported));
});

test("백업 왕복: 옛 파일을 가져오면 그때 보이던 순서(createdAt 순)가 그대로 살아난다", () => {
  // 옛 내보내기는 createdAt 오름차순으로 배열을 만들었다
  const oldFile = [
    { id: "a", createdAt: 100 },
    { id: "b", createdAt: 200 },
    { id: "c", createdAt: 300 },
  ];
  const imported = assignSectionOrder(oldFile);
  assert.equal(marks(imported), "a#0,b#1,c#2");
  // 붙이기 전 정렬(createdAt 순)과 같은 순서다
  assert.equal(
    sortProjects(imported).map((p) => p.id).join(","),
    "a,b,c"
  );
});
