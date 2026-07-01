// 팀 프로젝트 레이어 (Firestore teamProjects CRUD) — 개인 프로젝트와 동일 구조의 팀 버전.
//
// 개인 영역(personalProjects.js)과 똑같은 "프로젝트 > 세부 할일 > 진도율 + 간트" 구조를
// 팀 공용으로 복제한다. 다른 점은 소유 기준이 ownerUid 가 아니라 "선택된 팀(teamId)" 이라는 것.
//
//  - 내 소속: memberships 에서 uid==내 UID 인 문서로 teamId 목록을 만들고 팀 선택 UI 를 둔다.
//  - teamProjects 문서: { teamId(=선택된 팀), name, category(키: research|work),
//                         createdBy(=내 UID), createdAt }.
//    읽기는 teamId==선택된 팀인 것만(onSnapshot). 생성·수정·삭제는 팀원이면 가능(보안 규칙과 일치).
//  - 진도율: 선택된 팀의 teamTasks 를 projectId 별로 집계해 즉석 표시.
//  - 삭제: 그 projectId 의 teamTasks 를 연쇄 삭제(teamTasks.js 가 아니라 여기서 처리).
//
// DOM 조회는 .team-screen 루트로 한정해 개인 영역과 같은 클래스명을 써도 충돌하지 않는다.

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
  getDoc,
  addDoc,
  updateDoc,
  setDoc,
  doc,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { describeError } from "./cloudErrors.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const PROJECTS = "teamProjects";
const TASKS = "teamTasks";
const MEMBERSHIPS = "memberships";
const TEAMS = "teams";
const SELECT_EVENT = "team-project-selected"; // teamTasks.js 로 (teamId, projectId) 통지
// 슈퍼관리자 UID — 이 사람에게만 "새 팀 만들기" UI 를 노출한다.
const SUPER_ADMIN_UID = "NiNrcxpjoOTfr9dPLvq9jz3L8eK2";
// 팀 공용 카테고리: 표시 이름(label) ↔ 내부 키(key) 분리. Firestore 에는 key 를 저장한다.
const CATEGORIES = [
  { key: "research", label: "연구" },
  { key: "work", label: "업무" },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

// ----- DOM 참조 (.team-screen 루트로 한정) -----
const root = document.querySelector(".team-screen");
const selectEl = root.querySelector(".team-select");
const filterEl = root.querySelector(".pproj-filter");
const formEl = root.querySelector(".pproj-form");
const nameInput = root.querySelector(".pproj-name-input");
const catSelect = root.querySelector(".pproj-cat-select");
const errorEl = root.querySelector(".pproj-error");
const listEl = root.querySelector(".pproj-list");
const detailNameEl = root.querySelector(".pproj-detail-name");
// (새 팀 만들기는 '팀 관리' 탭으로 이동 → teamManage.js 가 담당)

// ----- 상태 -----
let currentUid = null;
let membershipUnsub = null;
let projectsUnsub = null;
let countsUnsub = null;
let myTeams = []; // [{ teamId, teamName }]
let selectedTeamId = null;
let projectsCache = [];
let taskCounts = {}; // { [projectId]: { total, done } }
let editingId = null;
let selectedProjectId = null;
let currentFilter = "all";
let extraCategories = []; // 선택된 팀의 추가 카테고리 [{id,name,color}] — teams 문서에서 읽음
let teamDocUnsub = null; // 선택된 팀 문서(teams/{teamId}) 구독(추가 카테고리 실시간 반영)

// 기본 + 추가 카테고리를 합친 목록: [{key,label,color?}] (color 는 추가 카테고리에만)
function allCategories() {
  return CATEGORIES.concat(
    extraCategories.map((c) => ({ key: c.id, label: c.name || c.id, color: c.color }))
  );
}
// 카테고리 키 → 표시 이름(기본 라벨 또는 추가 카테고리 이름)
function labelFor(key) {
  if (CATEGORY_LABEL[key]) return CATEGORY_LABEL[key];
  const ex = extraCategories.find((c) => c.id === key);
  return ex ? ex.name || ex.id : key || "";
}
// 추가 카테고리 색상(기본 카테고리는 CSS 로 색을 입히므로 null 반환)
function colorFor(key) {
  const ex = extraCategories.find((c) => c.id === key);
  return ex ? ex.color || null : null;
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

function createdMillis(p) {
  const ts = p.createdAt;
  if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  return Infinity;
}

// 선택(팀, 프로젝트) 변경을 teamTasks.js 에 알린다.
function emitSelection() {
  document.dispatchEvent(
    new CustomEvent(SELECT_EVENT, {
      detail: { teamId: selectedTeamId, projectId: selectedProjectId },
    })
  );
}
function setSelectedProject(id) {
  selectedProjectId = id;
  emitSelection();
}

// 팀 프로젝트 + 그 프로젝트의 teamTasks 를 원자적으로 연쇄 삭제.
async function deleteProjectCascade(projectId) {
  const tasksSnap = await getDocs(
    query(
      collection(db, TASKS),
      where("teamId", "==", selectedTeamId),
      where("projectId", "==", projectId)
    )
  );
  const batch = writeBatch(db);
  tasksSnap.forEach((d) => batch.delete(d.ref));
  batch.delete(doc(db, PROJECTS, projectId));
  await batch.commit();
}

// ----- 팀 선택 드롭다운 -----
function renderTeamSelect() {
  selectEl.innerHTML = "";
  if (myTeams.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "속한 팀이 없습니다";
    selectEl.append(opt);
    selectEl.disabled = true;
    return;
  }
  selectEl.disabled = false;
  myTeams.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.teamId;
    opt.textContent = t.teamName || t.teamId;
    if (t.teamId === selectedTeamId) opt.selected = true;
    selectEl.append(opt);
  });
}

// hex 색 → rgba(연한 배경 틴트용). 잘못된 형식이면 원본 반환.
function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex || "transparent";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// ----- 카테고리 필터 탭: 기본(전체/연구/업무) 뒤에 추가 카테고리 탭을 이어서 렌더 -----
// 기본 탭은 HTML 에 정적으로 있고, 추가 탭([data-extra])만 여기서 동적으로 붙였다 지운다.
// 기존 '연구'·'업무' 와 같은 알약형 .tab 을 그대로 쓰되, 자동 배정 색만 CSS 변수로 넘겨
// 색상으로만 구분한다(점(●) 없음). 활성/비활성 전환은 CSS 가 --cat-color 로 처리한다.
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
  // 활성 표시 동기화(재빌드 후에도 현재 필터 유지)
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

// ----- 선택된 프로젝트 이름을 우측 패널 제목에 반영 -----
function renderDetailHeader() {
  const sel = projectsCache.find((p) => p.id === selectedProjectId);
  detailNameEl.textContent = sel ? sel.name : "선택된 프로젝트 없음";
}

// 진도율 즉석 계산(저장하지 않음): { total, done, percent } (개인과 동일)
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

// ----- 프로젝트 목록 렌더 (진도율 포함) -----
function renderProjects() {
  listEl.innerHTML = "";
  renderDetailHeader();

  if (!currentUid) {
    listEl.append(emptyRow("로그인하면 팀 프로젝트가 표시됩니다."));
    return;
  }
  if (myTeams.length === 0) {
    listEl.append(
      emptyRow("속한 팀이 없습니다. 관리자에게 팀 추가(memberships)를 요청하세요.")
    );
    return;
  }
  if (!selectedTeamId) {
    listEl.append(emptyRow("볼 팀을 선택하세요."));
    return;
  }

  const visible = projectsCache
    .filter((p) => currentFilter === "all" || p.category === currentFilter)
    .sort((a, b) => createdMillis(a) - createdMillis(b));

  if (visible.length === 0) {
    listEl.append(
      emptyRow(
        currentFilter === "all"
          ? "이 팀에 등록된 프로젝트가 없습니다. 위에서 추가해 보세요."
          : `'${labelFor(currentFilter)}' 카테고리의 프로젝트가 없습니다.`
      )
    );
    return;
  }

  visible.forEach((proj) => {
    const li = document.createElement("li");
    li.className =
      "pproj-item" + (proj.id === selectedProjectId ? " is-selected" : "");
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
    li.setAttribute("aria-pressed", String(proj.id === selectedProjectId));

    const head = document.createElement("div");
    head.className = "pproj-item-head";

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

    head.append(name, badge, actions);
    li.append(head);

    // 진도율: 즉석 계산(저장 안 함) — "N% (done/total)" + 막대 + role=progressbar
    li.append(buildProgress(getProgress(proj.id)));

    listEl.append(li);
  });
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

// ----- 팀 선택 변경 -----
selectEl.addEventListener("change", () => {
  selectedTeamId = selectEl.value || null;
  editingId = null;
  currentFilter = "all"; // 팀마다 추가 카테고리 id 가 다르므로 필터를 전체로 초기화
  setSelectedProject(null); // 팀이 바뀌면 프로젝트 선택 초기화
  clearMessage();
  subscribeTeamDoc(selectedTeamId);
  subscribeProjects(selectedTeamId);
  subscribeTaskCounts(selectedTeamId);
  renderProjects();
});

// ----- 카테고리 필터 -----
filterEl.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  currentFilter = tab.dataset.pcat;
  filterEl
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("is-active", t === tab));
  renderProjects();
});

// ----- 생성 -----
formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUid) {
    showError("로그인 후 이용할 수 있습니다.");
    return;
  }
  if (!selectedTeamId) {
    showError("먼저 팀을 선택하세요.");
    return;
  }
  const name = nameInput.value.trim();
  const category = catSelect.value;
  if (!name) {
    showError("프로젝트 이름을 입력하세요.");
    return;
  }

  try {
    await addDoc(collection(db, PROJECTS), {
      teamId: selectedTeamId,
      name,
      category,
      createdBy: currentUid,
      createdAt: serverTimestamp(),
    });
    formEl.reset();
    nameInput.focus();
    clearMessage();
  } catch (e2) {
    console.error("팀 프로젝트 생성 실패:", e2);
    showError("생성에 실패했습니다: " + describeError(e2));
  }
});

// ----- 목록 이벤트(위임): 선택/수정/삭제/취소 -----
listEl.addEventListener("click", async (e) => {
  const li = e.target.closest(".pproj-item");
  if (!li) return;
  const id = li.dataset.id;
  const actionEl = e.target.closest("[data-action]");
  const action = actionEl ? actionEl.dataset.action : null;

  if (action === "edit") {
    editingId = id;
    clearMessage();
    renderProjects();
  } else if (action === "cancel-edit") {
    editingId = null;
    clearMessage();
    renderProjects();
  } else if (action === "delete") {
    const proj = projectsCache.find((p) => p.id === id);
    const nm = proj ? proj.name : "선택한";
    if (
      !confirm(
        `"${nm}" 팀 프로젝트를 삭제할까요?\n이 프로젝트의 세부 할 일도 모두 함께 삭제됩니다.`
      )
    )
      return;
    try {
      await deleteProjectCascade(id);
      if (selectedProjectId === id) setSelectedProject(null);
      clearMessage();
    } catch (err) {
      console.error("삭제 실패:", err);
      showError("삭제에 실패했습니다: " + describeError(err));
    }
  } else {
    if (e.target.closest(".pproj-edit-form")) return;
    setSelectedProject(id);
    renderProjects();
  }
});

// 키보드 선택(Enter/Space): 항목 자체에 포커스가 있을 때만 (내부 버튼/입력은 기본 동작 유지)
listEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const li = e.target.closest(".pproj-item");
  if (!li || e.target !== li) return;
  e.preventDefault();
  setSelectedProject(li.dataset.id);
  renderProjects();
});

// 인라인 수정 저장
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
    await updateDoc(doc(db, PROJECTS, id), { name, category });
    editingId = null;
    clearMessage();
    renderProjects(); // 스냅샷 타이밍과 무관하게 수정 폼을 확실히 닫음
  } catch (e2) {
    console.error("수정 실패:", e2);
    showError("수정에 실패했습니다: " + describeError(e2));
  }
});

// ----- 선택된 팀의 프로젝트 실시간 구독 -----
function subscribeProjects(teamId) {
  if (projectsUnsub) {
    projectsUnsub();
    projectsUnsub = null;
  }
  projectsCache = [];
  if (!teamId) {
    renderProjects();
    return;
  }
  const q = query(collection(db, PROJECTS), where("teamId", "==", teamId));
  projectsUnsub = onSnapshot(
    q,
    (snap) => {
      projectsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (
        selectedProjectId &&
        !projectsCache.some((p) => p.id === selectedProjectId)
      ) {
        setSelectedProject(null);
      }
      if (editingId && !projectsCache.some((p) => p.id === editingId)) {
        editingId = null;
      }
      renderProjects();
    },
    (err) => {
      console.error("팀 프로젝트 구독 실패:", err);
      showError(
        "프로젝트를 불러오지 못했습니다. 보안 규칙/소속을 확인하세요: " +
          describeError(err)
      );
    }
  );
}

// ----- 선택된 팀 문서 구독: 추가 카테고리(extraCategories) 실시간 반영 -----
function subscribeTeamDoc(teamId) {
  if (teamDocUnsub) {
    teamDocUnsub();
    teamDocUnsub = null;
  }
  extraCategories = [];
  if (!teamId) {
    renderFilterTabs();
    renderCatOptions();
    renderProjects();
    return;
  }
  teamDocUnsub = onSnapshot(
    doc(db, TEAMS, teamId),
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
      renderProjects();
    },
    (err) => {
      console.error("팀 문서(추가 카테고리) 구독 실패:", err);
    }
  );
}

// ----- 진도율 계산용: 선택된 팀의 teamTasks 를 projectId 별로 집계 -----
function subscribeTaskCounts(teamId) {
  if (countsUnsub) {
    countsUnsub();
    countsUnsub = null;
  }
  taskCounts = {};
  if (!teamId) {
    renderProjects();
    return;
  }
  const q = query(collection(db, TASKS), where("teamId", "==", teamId));
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
      renderProjects();
    },
    (err) => {
      console.error("팀 진도율 구독 실패:", err);
    }
  );
}

// ----- 내 소속(memberships) 구독 → 팀 목록 -----
function subscribeMemberships(uid) {
  const q = query(collection(db, MEMBERSHIPS), where("uid", "==", uid));
  membershipUnsub = onSnapshot(
    q,
    (snap) => {
      const seen = new Set();
      myTeams = [];
      snap.docs.forEach((d) => {
        const data = d.data();
        if (!data.teamId || seen.has(data.teamId)) return;
        seen.add(data.teamId);
        myTeams.push({ teamId: data.teamId, teamName: data.teamName || "" });
      });

      // 선택 팀 유지/초기화
      if (!selectedTeamId || !seen.has(selectedTeamId)) {
        selectedTeamId = myTeams.length ? myTeams[0].teamId : null;
        currentFilter = "all"; // 팀 전환 시 필터 초기화(추가 카테고리 id 는 팀마다 다름)
        setSelectedProject(null);
        subscribeTeamDoc(selectedTeamId);
        subscribeProjects(selectedTeamId);
        subscribeTaskCounts(selectedTeamId);
      }

      renderTeamSelect();
      renderProjects();
    },
    (err) => {
      console.error("소속(memberships) 구독 실패:", err);
      showError("소속 정보를 불러오지 못했습니다: " + describeError(err));
    }
  );
}

// ----- 인증 상태 -----
onAuthStateChanged(auth, (user) => {
  if (membershipUnsub) {
    membershipUnsub();
    membershipUnsub = null;
  }
  if (projectsUnsub) {
    projectsUnsub();
    projectsUnsub = null;
  }
  if (countsUnsub) {
    countsUnsub();
    countsUnsub = null;
  }
  if (teamDocUnsub) {
    teamDocUnsub();
    teamDocUnsub = null;
  }
  myTeams = [];
  selectedTeamId = null;
  projectsCache = [];
  taskCounts = {};
  extraCategories = [];
  currentFilter = "all";
  editingId = null;
  setSelectedProject(null);
  clearMessage();

  if (user) {
    currentUid = user.uid;
    subscribeMemberships(currentUid);
  } else {
    currentUid = null;
  }
  renderTeamSelect();
  renderFilterTabs();
  renderCatOptions();
  renderProjects();
});

// 첫 렌더(로그인 전)
renderTeamSelect();
renderFilterTabs();
renderCatOptions();
renderProjects();
