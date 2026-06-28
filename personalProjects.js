// 개인 프로젝트 레이어 (Firestore personalProjects CRUD)
//
// 개인 영역을 "평면 할 일"에서 "프로젝트 > 세부 할일" 구조로 바꾸는 1단계.
// 이번 단계는 개인 "프로젝트"만 만든다(세부 할일은 다음 단계 personalTasks).
//
// personalProjects 문서 필드: { ownerUid(=내 UID), name, category(키: research|lecture|study|daily), createdAt }
//  - 생성: 이름 + 카테고리. 이름이 공백이면 차단.
//  - 목록: ownerUid == 내 UID 인 프로젝트만 onSnapshot.
//  - 선택: 클릭하면 선택 상태 유지(다음 단계에서 그 프로젝트의 할일을 표시).
//  - 수정: 이름·카테고리 변경 / 삭제: 확인 후 문서만 삭제(하위 연쇄 삭제는 다음 단계에서 연결).
//  - 카테고리 필터(전체/업무/개인/공부)로 목록을 거른다.
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

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const COLLECTION = "personalProjects";
const TASKS_COLLECTION = "personalTasks"; // 연쇄 삭제 대상(세부 할일)
const SELECT_EVENT = "personal-project-selected"; // personalTasks.js 로 선택 변경 통지
// 개인용 카테고리: 표시 이름(label) ↔ 내부 키(key) 분리. Firestore 에는 key 를 저장한다.
const CATEGORIES = [
  { key: "research", label: "연구" },
  { key: "lecture", label: "강의" },
  { key: "study", label: "공부" },
  { key: "daily", label: "일상" },
];
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
let currentFilter = "all"; // "all" | "research" | "lecture" | "study" | "daily"

// ----- 메시지 -----
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove("is-info");
}
function clearMessage() {
  errorEl.textContent = "";
  errorEl.classList.remove("is-info");
}

function createdMillis(p) {
  const ts = p.createdAt;
  if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  return Infinity;
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

// ----- 목록 렌더 -----
function renderPersonalProjects() {
  listEl.innerHTML = "";
  renderDetailHeader();

  if (!currentUid) {
    listEl.append(emptyRow("로그인하면 개인 프로젝트가 표시됩니다."));
    return;
  }

  // 카테고리 필터 적용
  const visible = projectsCache
    .filter((p) => currentFilter === "all" || p.category === currentFilter)
    .sort((a, b) => createdMillis(a) - createdMillis(b));

  if (visible.length === 0) {
    listEl.append(
      emptyRow(
        currentFilter === "all"
          ? "등록된 개인 프로젝트가 없습니다. 위에서 추가해 보세요."
          : `'${CATEGORY_LABEL[currentFilter] || currentFilter}' 카테고리의 프로젝트가 없습니다.`
      )
    );
    return;
  }

  visible.forEach((proj) => {
    const li = document.createElement("li");
    li.className = "pproj-item" + (proj.id === selectedId ? " is-selected" : "");
    li.dataset.id = proj.id;

    if (editingId === proj.id) {
      li.classList.add("is-editing");
      li.append(buildEditForm(proj));
      listEl.append(li);
      return;
    }

    // 키보드로도 선택 가능하도록 항목 자체를 버튼처럼
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-pressed", String(proj.id === selectedId));

    const head = document.createElement("div");
    head.className = "pproj-item-head";

    const name = document.createElement("span");
    name.className = "pproj-item-name";
    name.textContent = proj.name;

    const badge = document.createElement("span");
    badge.className = "pcat-badge";
    badge.dataset.cat = proj.category || "";
    badge.textContent = CATEGORY_LABEL[proj.category] || proj.category || "";

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

    head.append(name, badge, actions);
    li.append(head);

    // 진도율: 즉석 계산(저장 안 함) — "N% (done/total)" + 막대 + role=progressbar
    li.append(buildProgress(getProgress(proj.id)));

    listEl.append(li);
  });
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
  CATEGORIES.forEach((c) => {
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

  if (action === "edit") {
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
  editingId = null;
  projectsCache = [];
  taskCounts = {};
  setSelected(null);
  clearMessage();

  if (user) {
    currentUid = user.uid;
    subscribe(currentUid);
    subscribeTaskCounts(currentUid);
  } else {
    currentUid = null;
  }
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
renderPersonalProjects();
