// 개인 프로젝트 레이어 (Firestore personalProjects CRUD)
//
// 개인 영역을 "평면 할 일"에서 "프로젝트 > 세부 할일" 구조로 바꾸는 1단계.
// 이번 단계는 개인 "프로젝트"만 만든다(세부 할일은 다음 단계 personalTasks).
//
// personalProjects 문서 필드: { ownerUid(=내 UID), name, category(키: daily 또는 추가 카테고리 id), createdAt }
//  - 생성: 이름 + 카테고리. 이름이 공백이면 차단.
//  - 목록: ownerUid == 내 UID 인 프로젝트만 onSnapshot.
//  - 선택: 클릭하면 선택 상태 유지(다음 단계에서 그 프로젝트의 할일을 표시).
//  - 수정: 이름·카테고리 변경 / 삭제: 확인 후 문서만 삭제(하위 연쇄 삭제는 다음 단계에서 연결).
//  - 카테고리 필터(전체/일상/추가 카테고리)로 목록을 거른다.
//
// 인증/Firebase 앱은 auth.js 가 초기화한 것을 재사용한다(personal/team 모듈과 동일 패턴).

import {
  initializeApp,
  getApps,
  getApp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  where,
  onSnapshot,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { describeError } from "./cloudErrors.js";
import {
  compareProjects,
  isDone,
  computeDrop,
  applyWrites,
  orderWriteFields,
} from "./projectOrder.js";
import { attachProjectDrag } from "./projectDrag.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const COLLECTION = "personalProjects";
const TASKS_COLLECTION = "personalTasks"; // 연쇄 삭제 대상(세부 할일)
const USERS = "users"; // 추가 카테고리(extraCategories)를 보관하는 본인 문서
const SELECT_EVENT = "personal-project-selected"; // personalTasks.js 로 선택 변경 통지
// 개인용 기본 카테고리: 이제 "일상"(daily) 하나. 표시 이름(label) ↔ 내부 키(key) 분리(Firestore 에는 key 저장).
// 추가 카테고리는 users/{uid}.extraCategories 에 사용자당 최대 3개까지 저장(personalCategories.js 가 관리).
// 한 번의 writeBatch 에 담을 최대 개수. Firestore 한도는 500 이라 여유를 둔다.
const ORDER_BATCH_LIMIT = 400;
const CATEGORIES = [{ key: "daily", label: "일상" }];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

// ----- DOM 참조 -----
const filterEl = document.querySelector(".pproj-filter");
const formEl = document.querySelector(".pproj-form");
const nameInput = document.querySelector(".pproj-name-input");
const catSelect = document.querySelector(".pproj-cat-select");
const errorEl = document.querySelector(".pproj-error");
const listEl = document.querySelector(".pproj-list");
const detailNameEl = document.querySelector(".pproj-detail-name");

// ----- 상태 -----
let currentUid = null;
let unsubscribe = null;
let countsUnsub = null; // 진도율 계산용 personalTasks 구독
let projectsCache = [];
let taskCounts = {}; // { [projectId]: { total, done } } — 즉석 계산용
let editingId = null;
let selectedId = null; // 선택된 프로젝트(세부 할일 조회에 사용)
let currentFilter = "all"; // "all" | "daily" | 추가 카테고리 id
let extraCategories = []; // 본인 추가 카테고리 [{id,name,color}] — users/{uid} 에서 읽음
let userDocUnsub = null; // users/{uid} 문서 구독(추가 카테고리 실시간 반영)
let isDraggingProjects = false; // 드래그 중에는 재렌더를 보류(끄는 카드가 DOM 에서 사라지지 않게)
let pendingRender = false; // 보류된 렌더가 있었는지 — 드래그가 끝나면 한 번 몰아서 그린다

// 기본 + 추가 카테고리를 합친 목록: [{key,label,color?}] (color 는 추가 카테고리에만)
function allCategories() {
  return CATEGORIES.concat(
    extraCategories.map((c) => ({ key: c.id, label: c.name || c.id, color: c.color }))
  );
}
// 카테고리 키 → 표시 이름
function labelFor(key) {
  if (CATEGORY_LABEL[key]) return CATEGORY_LABEL[key];
  const ex = extraCategories.find((c) => c.id === key);
  return ex ? ex.name || ex.id : key || "";
}
// 추가 카테고리 색상(기본 카테고리는 CSS 로 색을 입히므로 null)
function colorFor(key) {
  const ex = extraCategories.find((c) => c.id === key);
  return ex ? ex.color || null : null;
}
// hex 색 → rgba(연한 배경 틴트용). 잘못된 형식이면 원본 반환.
function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex || "transparent";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// ----- 카테고리 필터 탭: 기본(전체/일상) 뒤에 추가 카테고리 탭을 이어서 렌더 -----
// 기본 탭은 HTML 에 정적으로 있고, 추가 탭([data-extra])만 여기서 동적으로 붙였다 지운다.
function renderFilterTabs() {
  filterEl.querySelectorAll(".tab[data-extra]").forEach((t) => t.remove());
  extraCategories.forEach((c) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab";
    btn.dataset.pcat = c.id;
    btn.dataset.extra = "1";
    btn.textContent = c.name || c.id;
    const color = c.color || "#888";
    btn.style.setProperty("--cat-color", color);
    btn.style.setProperty("--cat-tint", hexToRgba(color, 0.14));
    filterEl.append(btn);
  });
  filterEl
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("is-active", t.dataset.pcat === currentFilter));
}

// ----- 프로젝트 생성 드롭다운: 기본 옵션 뒤에 추가 카테고리 옵션을 이어서 렌더 -----
function renderCatOptions() {
  catSelect.querySelectorAll("option[data-extra]").forEach((o) => o.remove());
  extraCategories.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name || c.id;
    opt.dataset.extra = "1";
    catSelect.append(opt);
  });
}

// ----- 메시지 -----
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove("is-info");
}
function clearMessage() {
  errorEl.textContent = "";
  errorEl.classList.remove("is-info");
}

// 선택된 프로젝트 변경을 personalTasks.js 에 알린다(모듈 간 통신).
// 같은 값으로 다시 호출돼도 personalTasks 쪽에서 중복 구독을 막는다.
function setSelected(id) {
  selectedId = id;
  document.dispatchEvent(
    new CustomEvent(SELECT_EVENT, { detail: { projectId: id } })
  );
}

// 프로젝트 + 그 프로젝트의 세부 할일을 한 번에(원자적으로) 삭제하는 연쇄 삭제.
// projectId 가 일치하는 personalTasks 만 지우므로 다른 프로젝트 할일은 영향 없음.
async function deleteProjectCascade(projectId) {
  const tasksSnap = await getDocs(
    query(
      collection(db, TASKS_COLLECTION),
      where("ownerUid", "==", currentUid),
      where("projectId", "==", projectId)
    )
  );
  const batch = writeBatch(db);
  tasksSnap.forEach((d) => batch.delete(d.ref));
  batch.delete(doc(db, COLLECTION, projectId));
  await batch.commit();
}

// ----- 선택된 프로젝트 이름을 우측 패널 제목에 반영 -----
function renderDetailHeader() {
  const sel = projectsCache.find((p) => p.id === selectedId);
  detailNameEl.textContent = sel ? sel.name : "선택된 프로젝트 없음";
}

// 진도율 즉석 계산(저장하지 않음): { total, done, percent }
function getProgress(projectId) {
  const c = taskCounts[projectId] || { total: 0, done: 0 };
  const percent = c.total ? Math.round((c.done / c.total) * 100) : 0;
  return { total: c.total, done: c.done, percent };
}

// 진도율 표시: "N% (done/total)" 라벨 + 막대 (role=progressbar)
function buildProgress({ total, done, percent }) {
  const wrap = document.createElement("div");
  wrap.className = "pproj-progress";

  const label = document.createElement("div");
  label.className = "progress-label";
  label.textContent =
    total === 0 ? "할 일 없음" : `${percent}% (${done}/${total})`;

  const progress = document.createElement("div");
  progress.className = "progress";
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-valuenow", String(percent));
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", "100");
  progress.setAttribute("aria-label", "진도율");

  const bar = document.createElement("div");
  bar.className = "progress-bar";
  bar.style.width = `${percent}%`;
  progress.append(bar);

  wrap.append(label, progress);
  return wrap;
}

// ----- 프로젝트 카드 한 장 (진행 중·완료 영역 공용) -----
function buildProjectItem(proj) {
  const li = document.createElement("li");
  li.className = "pproj-item" + (proj.id === selectedId ? " is-selected" : "");
  if (isDone(proj)) li.classList.add("is-done"); // 완료 영역: 톤 다운 표시
  li.dataset.id = proj.id;

  if (editingId === proj.id) {
    li.classList.add("is-editing");
    li.append(buildEditForm(proj));
    return li;
  }

  // 키보드로도 선택 가능하도록 항목 자체를 버튼처럼
  li.tabIndex = 0;
  li.setAttribute("role", "button");
  li.setAttribute("aria-pressed", String(proj.id === selectedId));

  const head = document.createElement("div");
  head.className = "pproj-item-head";

  // 끌기 손잡이. 카드 전체를 끌면 '선택' 클릭과 부딪히므로 잡는 곳을 따로 둔다.
  // 포인터 전용 기능이라 포커스는 주지 않고 보조기술에서도 숨긴다(aria-hidden).
  const handle = document.createElement("span");
  handle.className = "pproj-drag-handle";
  handle.dataset.action = "drag"; // 아래 클릭 위임에서 '선택'으로 새지 않게 막는 표식
  handle.title = "끌어서 순서 변경 / 완료로 이동";
  handle.setAttribute("aria-hidden", "true");
  handle.textContent = "⠿";

  const name = document.createElement("span");
  name.className = "pproj-item-name";
  name.textContent = proj.name;

  const badge = document.createElement("span");
  badge.className = "pcat-badge";
  badge.dataset.cat = proj.category || "";
  badge.textContent = labelFor(proj.category);
  // 추가 카테고리는 CSS 매핑이 없으므로 자동 배정된 색을 인라인으로 적용
  const badgeColor = colorFor(proj.category);
  if (badgeColor) badge.style.background = badgeColor;

  const actions = document.createElement("div");
  actions.className = "pproj-actions";
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "icon-btn";
  editBtn.dataset.action = "edit";
  editBtn.title = "수정";
  editBtn.textContent = "✎";
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "icon-btn icon-btn-danger";
  delBtn.dataset.action = "delete";
  delBtn.title = "삭제";
  delBtn.textContent = "🗑";
  actions.append(editBtn, delBtn);

  head.append(handle, name, badge, actions);
  li.append(head);

  // 진도율: 즉석 계산(저장 안 함) — "N% (done/total)" + 막대 + role=progressbar
  li.append(buildProgress(getProgress(proj.id)));

  return li;
}

// ----- 완료 영역 구분선 -----
// ⚠ 완료 영역이 비어 있어도 항상 렌더한다. 4단계에서 "완료로 옮기기"는 오직 이 선 아래로
//   끌어 놓는 것뿐이라, 선이 없으면 첫 프로젝트를 완료로 만들 방법이 사라진다.
function buildDoneDivider(count) {
  const li = document.createElement("li");
  li.className = "pproj-divider";
  const label = document.createElement("span");
  label.className = "pproj-divider-label";
  label.textContent = count > 0 ? `완료 (${count})` : "완료";
  li.append(label);
  return li;
}

// 완료 영역이 비었을 때의 안내 겸 드롭 자리(점선 박스). 최소 높이는 CSS 가 준다.
function buildDoneHint() {
  const li = document.createElement("li");
  li.className = "pproj-done-hint";
  li.textContent = "완료한 프로젝트를 여기로 끌어 놓으세요";
  return li;
}

// ----- 목록 렌더 -----
function renderPersonalProjects() {
  // 드래그 중에 다시 그리면 끌고 있던 카드가 통째로 교체돼 드래그가 끊긴다(간트에서 겪은 함정).
  // 스냅샷이 와도 여기서 막고, 드롭 직후에 한 번만 그린다.
  if (isDraggingProjects) {
    pendingRender = true;
    return;
  }
  listEl.innerHTML = "";
  renderDetailHeader();

  if (!currentUid) {
    listEl.append(emptyRow("로그인하면 개인 프로젝트가 표시됩니다."));
    return;
  }

  // 카테고리 필터 적용
  const visible = projectsCache
    .filter((p) => currentFilter === "all" || p.category === currentFilter)
    .sort(compareProjects); // 진행 중 먼저 → order → createdAt → id (projectOrder.js)

  if (visible.length === 0) {
    // 보이는 프로젝트가 하나도 없으면 구분선도 띄우지 않는다(끌어 놓을 대상 자체가 없음)
    listEl.append(
      emptyRow(
        currentFilter === "all"
          ? "등록된 개인 프로젝트가 없습니다. 위에서 추가해 보세요."
          : `'${labelFor(currentFilter)}' 카테고리의 프로젝트가 없습니다.`
      )
    );
    return;
  }

  // 두 영역으로 나눈다. visible 은 이미 compareProjects 로 정렬돼 있어
  // (진행 중 먼저 → order) 각 영역 '안'의 순서는 그대로 유지된다.
  const active = visible.filter((p) => !isDone(p));
  const done = visible.filter((p) => isDone(p));

  if (active.length === 0) {
    listEl.append(emptyRow("진행 중인 프로젝트가 없습니다."));
  } else {
    active.forEach((proj) => listEl.append(buildProjectItem(proj)));
  }

  listEl.append(buildDoneDivider(done.length));
  if (done.length === 0) {
    listEl.append(buildDoneHint());
  } else {
    done.forEach((proj) => listEl.append(buildProjectItem(proj)));
  }
}

// 진도율 계산용: 내 모든 personalTasks 를 구독해 projectId 별 완료/전체 수를 집계.
// 완료 토글 시 이 스냅샷이 갱신되어 목록 진도율이 즉시 반영된다.
function subscribeTaskCounts(uid) {
  const q = query(collection(db, TASKS_COLLECTION), where("ownerUid", "==", uid));
  countsUnsub = onSnapshot(
    q,
    (snap) => {
      const counts = {};
      snap.forEach((d) => {
        const t = d.data();
        if (!t.projectId) return;
        if (!counts[t.projectId]) counts[t.projectId] = { total: 0, done: 0 };
        counts[t.projectId].total++;
        if (t.completed) counts[t.projectId].done++;
      });
      taskCounts = counts;
      renderPersonalProjects();
    },
    (err) => {
      console.error("진도율 구독 실패:", err);
    }
  );
}

function emptyRow(text) {
  const li = document.createElement("li");
  li.className = "task-empty";
  li.textContent = text;
  return li;
}

// ----- 본인 users 문서 구독: 추가 카테고리(extraCategories) 실시간 반영 -----
function subscribeUserDoc(uid) {
  if (userDocUnsub) {
    userDocUnsub();
    userDocUnsub = null;
  }
  extraCategories = [];
  if (!uid) {
    renderFilterTabs();
    renderCatOptions();
    renderPersonalProjects();
    return;
  }
  userDocUnsub = onSnapshot(
    doc(db, USERS, uid),
    (snap) => {
      const data = snap.exists() ? snap.data() : {};
      extraCategories = Array.isArray(data.extraCategories)
        ? data.extraCategories
        : [];
      // 현재 필터가 사라진 추가 카테고리를 가리키면 전체로 되돌린다
      if (
        currentFilter !== "all" &&
        !CATEGORY_LABEL[currentFilter] &&
        !extraCategories.some((c) => c.id === currentFilter)
      ) {
        currentFilter = "all";
      }
      renderFilterTabs();
      renderCatOptions();
      renderPersonalProjects();
    },
    (err) => {
      console.error("users 문서(추가 카테고리) 구독 실패:", err);
    }
  );
}

// 인라인 수정 폼 (이름 + 카테고리)
function buildEditForm(proj) {
  const form = document.createElement("form");
  form.className = "pproj-edit-form";
  form.autocomplete = "off";

  const name = document.createElement("input");
  name.type = "text";
  name.className = "input pproj-edit-name";
  name.value = proj.name;
  name.setAttribute("aria-label", "프로젝트 이름");

  const cat = document.createElement("select");
  cat.className = "input pproj-edit-cat";
  cat.setAttribute("aria-label", "카테고리 선택");
  allCategories().forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.key;
    opt.textContent = c.label;
    if (c.key === proj.category) opt.selected = true;
    cat.append(opt);
  });

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "btn btn-add";
  saveBtn.textContent = "저장";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-cancel";
  cancelBtn.dataset.action = "cancel-edit";
  cancelBtn.textContent = "취소";

  form.append(name, cat, saveBtn, cancelBtn);
  return form;
}

// ----- 카테고리 필터 -----
filterEl.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  currentFilter = tab.dataset.pcat;
  filterEl
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("is-active", t === tab));
  renderPersonalProjects();
});

// ----- 생성 -----
formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUid) {
    showError("로그인 후 이용할 수 있습니다.");
    return;
  }
  const name = nameInput.value.trim();
  const category = catSelect.value;
  if (!name) {
    showError("프로젝트 이름을 입력하세요.");
    return;
  }

  try {
    await addDoc(collection(db, COLLECTION), {
      ownerUid: currentUid,
      name,
      category,
      createdAt: serverTimestamp(),
    });
    formEl.reset();
    nameInput.focus();
    clearMessage();
  } catch (e2) {
    console.error("개인 프로젝트 생성 실패:", e2);
    showError("생성에 실패했습니다: " + describeError(e2));
  }
});

// ----- 목록 영역 이벤트(위임): 선택 / 수정 / 삭제 / 취소 -----
listEl.addEventListener("click", async (e) => {
  const li = e.target.closest(".pproj-item");
  if (!li) return;
  const id = li.dataset.id;
  const actionEl = e.target.closest("[data-action]");
  const action = actionEl ? actionEl.dataset.action : null;

  if (action === "drag") {
    return; // 손잡이 클릭(끌기 끝난 뒤의 click 포함) — 선택으로 넘기지 않는다
  } else if (action === "edit") {
    editingId = id;
    clearMessage();
    renderPersonalProjects();
  } else if (action === "cancel-edit") {
    editingId = null;
    clearMessage();
    renderPersonalProjects();
  } else if (action === "delete") {
    const proj = projectsCache.find((p) => p.id === id);
    const nm = proj ? proj.name : "선택한";
    if (
      !confirm(
        `"${nm}" 프로젝트를 삭제할까요?\n이 프로젝트의 세부 할 일도 모두 함께 삭제됩니다.`
      )
    )
      return;
    try {
      await deleteProjectCascade(id);
      if (selectedId === id) setSelected(null);
      clearMessage();
    } catch (err) {
      console.error("삭제 실패:", err);
      showError("삭제에 실패했습니다: " + describeError(err));
    }
  } else {
    // 수정 폼 내부의 비액션 클릭(입력 포커스 등)은 무시 — 재렌더로 폼이 사라지지 않게
    if (e.target.closest(".pproj-edit-form")) return;
    // 그 외에는 프로젝트 선택(이 선택으로 세부 할일을 조회)
    setSelected(id);
    renderPersonalProjects();
  }
});

// 키보드 선택(Enter/Space): 항목 자체에 포커스가 있을 때만 (내부 버튼/입력은 기본 동작 유지)
listEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const li = e.target.closest(".pproj-item");
  if (!li || e.target !== li) return;
  e.preventDefault();
  setSelected(li.dataset.id);
  renderPersonalProjects();
});

// 인라인 수정 폼 저장
listEl.addEventListener("submit", async (e) => {
  const form = e.target.closest(".pproj-edit-form");
  if (!form) return;
  e.preventDefault();
  const li = e.target.closest(".pproj-item");
  if (!li) return;
  const id = li.dataset.id;

  const name = form.querySelector(".pproj-edit-name").value.trim();
  const category = form.querySelector(".pproj-edit-cat").value;
  if (!name) {
    showError("프로젝트 이름을 입력하세요.");
    return;
  }

  try {
    await updateDoc(doc(db, COLLECTION, id), { name, category });
    editingId = null;
    clearMessage();
    renderPersonalProjects(); // 스냅샷 타이밍과 무관하게 수정 폼을 확실히 닫음
  } catch (e2) {
    console.error("수정 실패:", e2);
    showError("수정에 실패했습니다: " + describeError(e2));
  }
});

// ----- 순서 드래그 -----
// 놓은 자리를 computeDrop 이 쓰기 목록으로 바꾸고, 바뀐 문서만 batch 로 저장한다.
attachProjectDrag({
  listEl,
  // 수정 폼이 열려 있으면 입력 중 카드가 움직이지 않도록 잠근다
  isEnabled: () => !!currentUid && editingId === null,
  onDragStateChange: (dragging) => {
    isDraggingProjects = dragging;
    if (!dragging && pendingRender) {
      pendingRender = false;
      renderPersonalProjects();
    }
  },
  onDrop: async (drop) => {
    const writes = computeDrop(projectsCache, drop);
    if (writes.length === 0) return;

    // 저장을 기다리지 않고 화면부터 새 순서로 바꾼다(낙관적 반영).
    // 실패하면 아래에서 되돌리고, 성공하면 곧 도착하는 스냅샷이 같은 결과로 덮어쓴다.
    const prev = projectsCache;
    const optimistic = applyWrites(prev, writes);
    projectsCache = optimistic;
    renderPersonalProjects();

    try {
      await saveOrder(writes, prev);
      clearMessage();
    } catch (err) {
      console.error("순서 저장 실패:", err);
      // 그 사이 새 스냅샷이 왔다면 그쪽이 진실이므로 건드리지 않는다
      if (projectsCache === optimistic) projectsCache = prev;
      renderPersonalProjects();
      showError("순서를 저장하지 못했습니다: " + describeError(err));
    }
  },
});

// 바뀐 문서만 batch 로 기록한다.
// doneAt 은 '완료 여부가 실제로 바뀐 문서'에만 쓴다 — 매번 덮으면 순서만 바꿔도
// 처음 완료한 시각이 사라진다.
async function saveOrder(writes, before) {
  const wasDone = new Map((before || []).map((p) => [p.id, isDone(p)]));
  for (let i = 0; i < writes.length; i += ORDER_BATCH_LIMIT) {
    const batch = writeBatch(db);
    writes.slice(i, i + ORDER_BATCH_LIMIT).forEach((w) => {
      const data = orderWriteFields(w, wasDone.get(w.id), serverTimestamp());
      batch.update(doc(db, COLLECTION, w.id), data);
    });
    await batch.commit();
  }
}

// ----- 실시간 구독 -----
function subscribe(uid) {
  const q = query(collection(db, COLLECTION), where("ownerUid", "==", uid));
  unsubscribe = onSnapshot(
    q,
    (snap) => {
      projectsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      // 선택/수정 중이던 프로젝트가 사라졌으면 상태 정리
      if (selectedId && !projectsCache.some((p) => p.id === selectedId)) {
        setSelected(null);
      }
      if (editingId && !projectsCache.some((p) => p.id === editingId)) {
        editingId = null;
      }
      renderPersonalProjects();
    },
    (err) => {
      console.error("개인 프로젝트 구독 실패:", err);
      showError(
        "목록을 불러오지 못했습니다. Firestore 보안 규칙을 확인하세요: " +
          describeError(err)
      );
    }
  );
}

// ----- 인증 상태에 따라 구독 시작/중단 -----
onAuthStateChanged(auth, (user) => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (countsUnsub) {
    countsUnsub();
    countsUnsub = null;
  }
  if (userDocUnsub) {
    userDocUnsub();
    userDocUnsub = null;
  }
  editingId = null;
  projectsCache = [];
  taskCounts = {};
  extraCategories = [];
  currentFilter = "all";
  setSelected(null);
  clearMessage();

  if (user) {
    currentUid = user.uid;
    subscribe(currentUid);
    subscribeTaskCounts(currentUid);
    subscribeUserDoc(currentUid);
  } else {
    currentUid = null;
  }
  renderFilterTabs();
  renderCatOptions();
  renderPersonalProjects();
});

// ----- 상단 화면 전환(프로젝트 / 개인 할 일 / 팀 공용) -----
// (이전 personal.js 에 있던 핸들러를 이 모듈로 옮겨 옴)
const viewSwitch = document.querySelector(".view-switch");
if (viewSwitch) {
  viewSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest(".vbtn");
    if (!btn) return;
    document.body.setAttribute("data-view-mode", btn.dataset.mode);
    viewSwitch.querySelectorAll(".vbtn").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", String(active));
    });
  });
}

// 첫 렌더(로그인 전 안내)
renderFilterTabs();
renderCatOptions();
renderPersonalProjects();
