// 2단계: 데이터 모델과 localStorage 영속성.
// 화면 조작은 아직 연결하지 않습니다. 데이터 레이어만 구성합니다.
//
// 데이터 구조
//   프로젝트:    { id, name, category("work"|"personal"|"study"), createdAt(ISO) }
//   세부 할 일:  { id, projectId, title, startDate("YYYY-MM-DD"),
//                  endDate("YYYY-MM-DD"), completed(bool), createdAt(ISO) }

// localStorage 키
const STORAGE_KEYS = {
  projects: "daylist.projects",
  tasks: "daylist.tasks",
  selected: "daylist.selectedProjectId",
  ganttUnits: "daylist.ganttUnits",
  ganttRanges: "daylist.ganttRanges",
  ganttLabelWidths: "daylist.ganttLabelWidths",
  listRanges: "daylist.listRanges",
};

// 메모리 보관용 배열
let projects = [];
let tasks = [];

// 고유 id 생성
function createId() {
  return crypto.randomUUID();
}

// 새 프로젝트/할 일 객체를 만드는 헬퍼 (id, createdAt 자동 채움)
function makeProject(name, category) {
  return {
    id: createId(),
    name,
    category,
    createdAt: new Date().toISOString(),
  };
}

function makeTask(projectId, title, startDate, endDate) {
  return {
    id: createId(),
    projectId,
    title,
    startDate,
    endDate,
    completed: false,
    createdAt: new Date().toISOString(),
  };
}

// 메모리 배열을 localStorage에 저장
function save() {
  try {
    localStorage.setItem(STORAGE_KEYS.projects, JSON.stringify(projects));
    localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(tasks));
  } catch (err) {
    console.error("save() 실패:", err);
  }
}

// 선택된 프로젝트 id를 영속화 (데이터와 분리해 가볍게 저장)
function saveSelection() {
  try {
    if (selectedProjectId) {
      localStorage.setItem(STORAGE_KEYS.selected, selectedProjectId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.selected);
    }
  } catch (err) {
    console.error("saveSelection() 실패:", err);
  }
}

// 저장된 선택 id를 복원. 해당 프로젝트가 없으면 null.
function loadSelection() {
  try {
    const id = localStorage.getItem(STORAGE_KEYS.selected);
    return id && projects.some((p) => p.id === id) ? id : null;
  } catch (err) {
    console.error("loadSelection() 실패:", err);
    return null;
  }
}

// 프로젝트별 간트 축 단위 맵을 저장
function saveGanttUnits() {
  try {
    localStorage.setItem(STORAGE_KEYS.ganttUnits, JSON.stringify(ganttUnits));
  } catch (err) {
    console.error("saveGanttUnits() 실패:", err);
  }
}

// 프로젝트별 간트 축 단위 맵을 복원. 없거나 손상되면 빈 객체.
function loadGanttUnits() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ganttUnits);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (err) {
    console.error("loadGanttUnits() 실패:", err);
    return {};
  }
}

// 프로젝트별 간트 표시 기간 맵 { [projectId]: { start, end } } 을 저장
function saveGanttRanges() {
  try {
    localStorage.setItem(STORAGE_KEYS.ganttRanges, JSON.stringify(ganttRanges));
  } catch (err) {
    console.error("saveGanttRanges() 실패:", err);
  }
}

// 간트 표시 기간 맵을 복원. 없거나 손상되면 빈 객체.
function loadGanttRanges() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ganttRanges);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (err) {
    console.error("loadGanttRanges() 실패:", err);
    return {};
  }
}

// 프로젝트별 간트 라벨 열 너비 맵 { [projectId]: px } 을 저장
function saveGanttLabelWidths() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.ganttLabelWidths,
      JSON.stringify(ganttLabelWidths)
    );
  } catch (err) {
    console.error("saveGanttLabelWidths() 실패:", err);
  }
}

// 간트 라벨 열 너비 맵을 복원. 없거나 손상되면 빈 객체.
function loadGanttLabelWidths() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ganttLabelWidths);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (err) {
    console.error("loadGanttLabelWidths() 실패:", err);
    return {};
  }
}

// 프로젝트별 '목록' 표시 기간 맵 { [projectId]: { start, end } } 을 저장
function saveListRanges() {
  try {
    localStorage.setItem(STORAGE_KEYS.listRanges, JSON.stringify(listRanges));
  } catch (err) {
    console.error("saveListRanges() 실패:", err);
  }
}

// '목록' 표시 기간 맵을 복원. 없거나 손상되면 빈 객체.
function loadListRanges() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.listRanges);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (err) {
    console.error("loadListRanges() 실패:", err);
    return {};
  }
}

// 단일 키를 안전하게 읽어 배열로 복원. 없거나 손상되면 빈 배열.
function loadArray(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`load() 실패 (${key}):`, err);
    return [];
  }
}

// localStorage에서 메모리 배열로 복원
function load() {
  projects = loadArray(STORAGE_KEYS.projects);
  tasks = loadArray(STORAGE_KEYS.tasks);
}

// 페이지 로드 시 복원
load();

// =====================================================================
// 3단계: 프로젝트 생성·렌더링·선택 + 카테고리 필터
// =====================================================================

// 카테고리 화면 표기 및 badge 클래스 매핑
const CATEGORY_LABELS = {
  work: "업무",
  personal: "개인",
  study: "공부",
};
const CATEGORY_BADGE_CLASS = {
  work: "badge-work",
  personal: "badge-personal",
  study: "badge-study",
};

// 화면 상태 (데이터가 아니라 UI 상태)
let selectedProjectId = null; // 현재 선택된 프로젝트 id
let editingProjectId = null; // 인라인 수정 중인 프로젝트 id
let editingTaskId = null; // 인라인 수정 중인 할 일 id
let currentFilter = "all"; // 현재 카테고리 필터 ("all" | "work" | "personal" | "study")

// 저장된 선택 상태 복원 (projects 로드 이후)
selectedProjectId = loadSelection();

// DOM 참조
const projectListEl = document.querySelector(".project-list");
const projectForm = document.querySelector(".project-form");
const projectNameInput = document.querySelector(".project-name-input");
const projectCategorySelect = document.querySelector(".project-category-select");
const categoryTabsEl = document.querySelector(".category-tabs");
const taskListEl = document.querySelector(".task-list");
const listToolbarEl = document.querySelector(".list-toolbar");
const taskForm = document.querySelector(".task-form");
const taskTitleInput = document.querySelector(".task-title-input");
const taskStartInput = document.querySelector(".task-start-input");
const taskEndInput = document.querySelector(".task-end-input");
const tasksProjectNameEl = document.querySelector(".tasks-project-name");
const ganttEl = document.querySelector(".gantt");
const viewTabsEl = document.querySelector(".view-tabs");

let taskView = "list"; // 우측 패널 보기 모드 ("list" | "gantt")
// 프로젝트별 간트 축 단위 { [projectId]: "auto"|"day"|"week"|"month" } — 저장값 복원
let ganttUnits = loadGanttUnits();
// 프로젝트별 간트 표시 기간 { [projectId]: { start, end } } — 저장값 복원
let ganttRanges = loadGanttRanges();
// 프로젝트별 간트 라벨 열 너비(px) { [projectId]: number } — 저장값 복원
let ganttLabelWidths = loadGanttLabelWidths();
let ganttRangeOpen = false; // 간트 '기간 설정' 편집 폼 열림 여부 (UI 상태)
// 프로젝트별 '목록' 표시 기간 { [projectId]: { start, end } } — 저장값 복원
let listRanges = loadListRanges();
let listRangeOpen = false; // 목록 '기간 설정' 편집 폼 열림 여부 (UI 상태)

// 내보내기 헤더에 쓰는, 마지막으로 렌더된 각 보기의 표시 기간 라벨
let listRangeLabel = ""; // 목록 보기의 현재 표시 기간 텍스트
let ganttRangeLabel = ""; // 간트 보기의 현재 표시 기간 텍스트

// 라벨 열 너비 기본값/최소·최대 (px)
const DEFAULT_LABEL_WIDTH = 150;
const MIN_LABEL_WIDTH = 90;
const MAX_LABEL_WIDTH = 480;

// 현재 선택된 프로젝트의 축 단위 (없으면 "auto")
function getGanttUnit() {
  return ganttUnits[selectedProjectId] || "auto";
}

// 현재 선택된 프로젝트의 표시 기간 (없으면 null = 전체 보기)
function getGanttRange() {
  const r = ganttRanges[selectedProjectId];
  return r && r.start && r.end ? r : null;
}

// 현재 선택된 프로젝트의 '목록' 표시 기간 (없으면 null = 전체 보기)
function getListRange() {
  const r = listRanges[selectedProjectId];
  return r && r.start && r.end ? r : null;
}

// 현재 선택된 프로젝트의 라벨 열 너비 (없으면 기본값)
function getGanttLabelWidth() {
  const w = ganttLabelWidths[selectedProjectId];
  return typeof w === "number" && w > 0 ? w : DEFAULT_LABEL_WIDTH;
}

// 프로젝트 목록 렌더링. 변경 시마다 호출.
function renderProjects() {
  const visible =
    currentFilter === "all"
      ? projects
      : projects.filter((p) => p.category === currentFilter);

  projectListEl.innerHTML = "";

  // 빈 상태 안내
  if (visible.length === 0) {
    const empty = document.createElement("li");
    empty.className = "task-empty";
    empty.textContent =
      projects.length === 0
        ? "프로젝트가 없습니다. 위에서 추가하세요."
        : "이 카테고리에 해당하는 프로젝트가 없습니다.";
    projectListEl.append(empty);
    return;
  }

  visible.forEach((project) => {
    const li = document.createElement("li");
    li.className = "project-item";
    if (project.id === selectedProjectId) li.classList.add("is-selected");
    li.dataset.id = project.id;

    if (project.id === editingProjectId) {
      li.append(buildEditForm(project));
    } else {
      // 키보드로도 선택 가능하도록 포커스/역할 부여
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.setAttribute("aria-pressed", String(project.id === selectedProjectId));
      li.append(buildProjectHead(project), buildProgress(getProgress(project.id)));
    }

    projectListEl.append(li);
  });
}

// 진도율 즉석 계산 (저장하지 않음): { total, done, percent }
function getProgress(projectId) {
  const list = tasks.filter((t) => t.projectId === projectId);
  const total = list.length;
  const done = list.filter((t) => t.completed).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, percent };
}

// 일반 보기: 이름 + badge + 수정/삭제 버튼
function buildProjectHead(project) {
  const head = document.createElement("div");
  head.className = "project-item-head";

  const name = document.createElement("span");
  name.className = "project-item-name";
  name.textContent = project.name;

  const badge = document.createElement("span");
  badge.className = `badge ${CATEGORY_BADGE_CLASS[project.category] || ""}`;
  badge.textContent = CATEGORY_LABELS[project.category] || project.category;

  const actions = document.createElement("div");
  actions.className = "project-actions";
  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.dataset.action = "edit";
  editBtn.title = "수정";
  editBtn.textContent = "✎";
  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn icon-btn-danger";
  delBtn.dataset.action = "delete";
  delBtn.title = "삭제";
  delBtn.textContent = "🗑";
  actions.append(editBtn, delBtn);

  head.append(name, badge, actions);
  return head;
}

// 진도율: % 라벨 + 막대 (FR-06)
function buildProgress({ total, done, percent }) {
  const wrap = document.createElement("div");
  wrap.className = "progress-wrap";

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

// 인라인 수정 폼: 이름 + 카테고리 + 저장/취소
function buildEditForm(project) {
  const form = document.createElement("form");
  form.className = "project-edit-form";

  const nameInput = document.createElement("input");
  nameInput.className = "input edit-name-input";
  nameInput.type = "text";
  nameInput.value = project.name;
  nameInput.setAttribute("aria-label", "프로젝트 이름 수정");

  const select = document.createElement("select");
  select.className = "input edit-category-select";
  select.setAttribute("aria-label", "카테고리 수정");
  Object.entries(CATEGORY_LABELS).forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (value === project.category) opt.selected = true;
    select.append(opt);
  });

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "btn btn-add";
  saveBtn.dataset.action = "save";
  saveBtn.textContent = "저장";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-cancel";
  cancelBtn.dataset.action = "cancel";
  cancelBtn.textContent = "취소";

  form.append(nameInput, select, saveBtn, cancelBtn);
  return form;
}

// 프로젝트 수정 (FR-02): 이름/카테고리 변경
function applyProjectEdit(id, li) {
  const project = projects.find((p) => p.id === id);
  if (!project) return;

  const name = li.querySelector(".edit-name-input").value.trim();
  if (!name) return; // 공백만 입력 차단

  project.name = name;
  project.category = li.querySelector(".edit-category-select").value;
  editingProjectId = null;
  save();
  renderProjects();
}

// 프로젝트 삭제 (FR-02): 확인 후 연쇄 삭제 (해당 프로젝트의 할 일만 함께 제거)
function deleteProject(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) return;

  const ok = confirm(
    `"${project.name}" 프로젝트를 삭제할까요?\n` +
      `이 프로젝트의 세부 할 일도 모두 함께 삭제됩니다.`
  );
  if (!ok) return;

  projects = projects.filter((p) => p.id !== id);
  // 연쇄 삭제: 이 프로젝트의 할 일만 제거, 다른 프로젝트 할 일은 보존
  tasks = tasks.filter((t) => t.projectId !== id);

  // 이 프로젝트의 축 단위 설정도 정리
  if (id in ganttUnits) {
    delete ganttUnits[id];
    saveGanttUnits();
  }
  // 이 프로젝트의 표시 기간/라벨 너비 설정도 정리
  if (id in ganttRanges) {
    delete ganttRanges[id];
    saveGanttRanges();
  }
  if (id in ganttLabelWidths) {
    delete ganttLabelWidths[id];
    saveGanttLabelWidths();
  }
  if (id in listRanges) {
    delete listRanges[id];
    saveListRanges();
  }

  if (selectedProjectId === id) {
    selectedProjectId = null;
    saveSelection();
  }
  if (editingProjectId === id) editingProjectId = null;

  save();
  renderProjects();
  renderTasks();
}

// 프로젝트 생성 (FR-01): 이름 + 카테고리. 공백만 입력하면 차단.
projectForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = projectNameInput.value.trim();
  if (!name) return; // 공백만 입력 차단

  const project = makeProject(name, projectCategorySelect.value);
  projects.push(project);
  save();

  projectNameInput.value = "";
  renderProjects();
});

// 프로젝트 목록 클릭: 액션 버튼(수정/삭제/취소) 또는 선택
projectListEl.addEventListener("click", (e) => {
  const item = e.target.closest(".project-item");
  if (!item) return;
  const id = item.dataset.id;

  const actionBtn = e.target.closest("[data-action]");
  if (actionBtn) {
    const action = actionBtn.dataset.action;
    if (action === "edit") {
      editingProjectId = id;
      renderProjects();
    } else if (action === "delete") {
      deleteProject(id);
    } else if (action === "cancel") {
      editingProjectId = null;
      renderProjects();
    }
    // "save"는 폼 submit에서 처리
    return;
  }

  // 수정 폼 내부 입력 클릭은 선택으로 처리하지 않음
  if (e.target.closest(".project-edit-form")) return;

  selectedProjectId = id;
  saveSelection();
  renderProjects();
  renderTasks();
});

// 프로젝트 항목 키보드 선택 (Enter/Space)
projectListEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const item = e.target.closest(".project-item");
  // 항목 자체에 포커스가 있을 때만 (내부 버튼/입력은 기본 동작 유지)
  if (!item || e.target !== item) return;
  e.preventDefault();
  selectedProjectId = item.dataset.id;
  saveSelection();
  renderProjects();
  renderTasks();
});

// 인라인 수정 폼 저장 (submit: 버튼 클릭/엔터 모두 처리)
projectListEl.addEventListener("submit", (e) => {
  const form = e.target.closest(".project-edit-form");
  if (!form) return;
  e.preventDefault();
  const item = form.closest(".project-item");
  applyProjectEdit(item.dataset.id, item);
});

// 카테고리 필터 (FR-07): 탭으로 목록 필터링, 선택 탭 강조
categoryTabsEl.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;

  currentFilter = tab.dataset.category;

  categoryTabsEl
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("is-active", t === tab));

  renderProjects();
});

// =====================================================================
// 5단계: 세부 할 일 추가·렌더링·완료 체크
// =====================================================================

// 종료일까지 남은 일수 (날짜 단위). endDate 없으면 null.
function daysUntil(endDate) {
  if (!endDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(end.getTime())) return null;
  return Math.round((end - today) / 86400000);
}

// 마감 상태: 완료된 항목은 표시 안 함.
// { kind: "overdue"|"soon", label } 또는 null 반환. (임박 기준: 종료일까지 3일 이내)
function getDueStatus(task) {
  if (task.completed) return null;
  const d = daysUntil(task.endDate);
  if (d === null) return null;
  if (d < 0) return { kind: "overdue", label: `${-d}일 지남` };
  if (d === 0) return { kind: "soon", label: "오늘 마감" };
  if (d <= 3) return { kind: "soon", label: `D-${d}` };
  return null;
}

// 우측 패널 렌더링 디스패처: 두 보기를 모두 갱신(숨김은 CSS가 처리).
function renderTasks() {
  renderTaskList();
  renderGantt();
}

// ----- 날짜 유틸 -----
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 두 날짜(YMD) 사이의 일수
function dayDiff(start, end) {
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  return Math.round((b - a) / 86400000);
}

// 전체 기간 길이에 따라 축 단위를 자동 선택
function pickUnit(minStart, maxEnd) {
  const span = dayDiff(minStart, maxEnd) + 1;
  if (span <= 45) return "day";
  if (span <= 365) return "week";
  return "month";
}

// 매년 날짜가 고정인 한국 양력 공휴일 (MM-DD).
const FIXED_HOLIDAYS = {
  "01-01": "신정",
  "03-01": "삼일절",
  "05-05": "어린이날",
  "06-06": "현충일",
  "08-15": "광복절",
  "10-03": "개천절",
  "10-09": "한글날",
  "12-25": "성탄절",
};

// 음력 기반 공휴일의 연도별 양력 날짜 (설날·추석은 연휴 3일, 부처님오신날 1일).
// 출처: worlddata.info / publicholidays.co.kr. 범위 밖 연도는 양력 공휴일만 표시됩니다.
const LUNAR_HOLIDAYS = {
  2024: [["2024-02-09", "설날"], ["2024-02-10", "설날"], ["2024-02-11", "설날"], ["2024-05-15", "부처님오신날"], ["2024-09-16", "추석"], ["2024-09-17", "추석"], ["2024-09-18", "추석"]],
  2025: [["2025-01-28", "설날"], ["2025-01-29", "설날"], ["2025-01-30", "설날"], ["2025-05-05", "부처님오신날"], ["2025-10-05", "추석"], ["2025-10-06", "추석"], ["2025-10-07", "추석"]],
  2026: [["2026-02-16", "설날"], ["2026-02-17", "설날"], ["2026-02-18", "설날"], ["2026-05-24", "부처님오신날"], ["2026-09-24", "추석"], ["2026-09-25", "추석"], ["2026-09-26", "추석"]],
  2027: [["2027-02-05", "설날"], ["2027-02-06", "설날"], ["2027-02-07", "설날"], ["2027-05-13", "부처님오신날"], ["2027-09-14", "추석"], ["2027-09-15", "추석"], ["2027-09-16", "추석"]],
  2028: [["2028-01-25", "설날"], ["2028-01-26", "설날"], ["2028-01-27", "설날"], ["2028-05-02", "부처님오신날"], ["2028-10-02", "추석"], ["2028-10-03", "추석"], ["2028-10-04", "추석"]],
  2029: [["2029-02-12", "설날"], ["2029-02-13", "설날"], ["2029-02-14", "설날"], ["2029-05-20", "부처님오신날"], ["2029-09-21", "추석"], ["2029-09-22", "추석"], ["2029-09-23", "추석"]],
  2030: [["2030-02-02", "설날"], ["2030-02-03", "설날"], ["2030-02-04", "설날"], ["2030-05-09", "부처님오신날"], ["2030-09-11", "추석"], ["2030-09-12", "추석"], ["2030-09-13", "추석"]],
};

// 대체공휴일 적용 대상 (신정·현충일은 제외)
const SUBSTITUTE_ELIGIBLE = new Set([
  "삼일절", "어린이날", "광복절", "개천절", "한글날", "성탄절",
  "설날", "추석", "부처님오신날",
]);

// 연도별 공휴일 맵 { "YYYY-MM-DD": 이름 } 을 계산(대체공휴일 포함)하고 캐시.
const _holidayCache = {};
function getYearHolidays(year) {
  if (_holidayCache[year]) return _holidayCache[year];

  const map = {};
  const overlaps = new Set(); // 두 공휴일이 같은 날 겹친 날짜
  const add = (date, name) => {
    if (map[date]) overlaps.add(date);
    else map[date] = name;
  };

  for (const [md, name] of Object.entries(FIXED_HOLIDAYS)) add(`${year}-${md}`, name);
  for (const [date, name] of LUNAR_HOLIDAYS[year] || []) add(date, name);

  // 대체공휴일: 적용 대상이 주말이거나 다른 공휴일과 겹치면, 다음 평일(공휴일 아님)로 이월
  const isWeekend = (d) => {
    const g = new Date(`${d}T00:00:00`).getDay();
    return g === 0 || g === 6;
  };
  const nextDay = (d) => {
    const x = new Date(`${d}T00:00:00`);
    x.setDate(x.getDate() + 1);
    return toYMD(x);
  };
  const eligible = Object.keys(map)
    .filter((d) => SUBSTITUTE_ELIGIBLE.has(map[d]))
    .sort();
  for (const d of eligible) {
    if (isWeekend(d) || overlaps.has(d)) {
      let s = nextDay(d);
      while (isWeekend(s) || map[s]) s = nextDay(s);
      map[s] = "대체공휴일";
    }
  }

  _holidayCache[year] = map;
  return map;
}

// 공휴일 이름 (없으면 null)
function getHolidayName(ymd) {
  return getYearHolidays(Number(ymd.slice(0, 4)))[ymd] || null;
}

// 날짜의 주말/공휴일 구분 클래스 ("is-holiday" | "is-sun" | "is-sat" | "")
function dayMarkClass(ymd) {
  if (getHolidayName(ymd)) return "is-holiday";
  const dow = new Date(`${ymd}T00:00:00`).getDay(); // 0=일 ... 6=토
  if (dow === 0) return "is-sun";
  if (dow === 6) return "is-sat";
  return "";
}

// 월요일 시작 주의 시작일
function startOfWeek(date) {
  const x = new Date(date);
  const offset = (x.getDay() + 6) % 7; // 월=0 ... 일=6
  x.setDate(x.getDate() - offset);
  x.setHours(0, 0, 0, 0);
  return x;
}

// 축 기간 배열 생성: [{ start, end, label }]. 각 칸은 day/week/month 한 구간.
function buildPeriods(minStart, maxEnd, unit) {
  const periods = [];
  const last = new Date(`${maxEnd}T00:00:00`);
  let cur = new Date(`${minStart}T00:00:00`);
  let guard = 0;

  const dayLabel = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

  if (unit === "day") {
    while (cur <= last && guard < 2000) {
      const s = toYMD(cur);
      periods.push({ start: s, end: s, label: dayLabel(cur) });
      cur.setDate(cur.getDate() + 1);
      guard++;
    }
  } else if (unit === "week") {
    cur = startOfWeek(cur);
    while (cur <= last && guard < 1000) {
      const start = new Date(cur);
      const end = new Date(cur);
      end.setDate(end.getDate() + 6);
      periods.push({ start: toYMD(start), end: toYMD(end), label: dayLabel(start) });
      cur.setDate(cur.getDate() + 7);
      guard++;
    }
  } else {
    cur = new Date(cur.getFullYear(), cur.getMonth(), 1);
    while (cur <= last && guard < 600) {
      const start = new Date(cur.getFullYear(), cur.getMonth(), 1);
      const end = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const label = `${cur.getFullYear()}.${String(cur.getMonth() + 1).padStart(2, "0")}`;
      periods.push({ start: toYMD(start), end: toYMD(end), label });
      cur.setMonth(cur.getMonth() + 1);
      guard++;
    }
  }
  return periods;
}

// YMD가 속한 기간 인덱스 (없으면 -1)
function findPeriodIndex(periods, ymd) {
  return periods.findIndex((p) => ymd >= p.start && ymd <= p.end);
}

// 간트차트 안내 문구 요소
function ganttMessage(text) {
  const p = document.createElement("p");
  p.className = "gantt-note";
  p.textContent = text;
  return p;
}

// 간트 단위 선택기 + 기간 설정 + 안내.
//   dataRange:   할 일 데이터에서 도출한 { start, end } (편집 폼 기본값)
//   activeRange: 현재 적용 중인 사용자 지정 기간 또는 null
function buildGanttControls(dataRange, activeRange) {
  const wrap = document.createElement("div");
  wrap.className = "gantt-controls";

  const label = document.createElement("label");
  label.className = "gantt-control-label";
  label.textContent = "축 단위";

  const select = document.createElement("select");
  select.className = "input gantt-unit-select";
  select.setAttribute("aria-label", "간트 축 단위 선택");
  const options = [
    ["auto", "자동"],
    ["day", "일"],
    ["week", "주"],
    ["month", "월"],
  ];
  const current = getGanttUnit();
  options.forEach(([value, text]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    if (value === current) opt.selected = true;
    select.append(opt);
  });
  label.append(select);

  // 기간 설정 토글 버튼
  const rangeBtn = document.createElement("button");
  rangeBtn.type = "button";
  rangeBtn.className = "btn btn-cancel gantt-range-toggle";
  rangeBtn.setAttribute("aria-expanded", String(ganttRangeOpen));
  rangeBtn.textContent = "기간 설정";

  const hint = document.createElement("span");
  hint.className = "gantt-note gantt-hint";
  // 축 단위(자동/일/주/월)와 무관하게 동일한 안내 문구를 표시
  hint.textContent = "할일 또는 막대를 클릭하면 수정 가능";

  wrap.append(label, rangeBtn, hint);

  // 내보내기 버튼 (PNG / PDF)
  wrap.append(buildExportButtons("gantt"));

  // 적용 중인 사용자 지정 기간 표시 + 전체 보기 복귀
  if (activeRange) {
    const tag = document.createElement("span");
    tag.className = "gantt-range-tag";
    tag.textContent = `표시 기간: ${activeRange.start} ~ ${activeRange.end}`;

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "gantt-range-reset";
    resetBtn.textContent = "전체 보기";

    wrap.append(tag, resetBtn);
  }

  // 기간 설정 편집 폼 (토글로 표시)
  if (ganttRangeOpen) {
    const editor = document.createElement("div");
    editor.className = "gantt-range-editor";

    const startWrap = document.createElement("label");
    startWrap.className = "field-label";
    startWrap.append("시작 ");
    const startInput = document.createElement("input");
    startInput.type = "date";
    startInput.className = "input gantt-range-start";
    startInput.setAttribute("aria-label", "표시 시작일");
    startInput.value = (activeRange || dataRange).start;
    startWrap.append(startInput);

    const endWrap = document.createElement("label");
    endWrap.className = "field-label";
    endWrap.append("종료 ");
    const endInput = document.createElement("input");
    endInput.type = "date";
    endInput.className = "input gantt-range-end";
    endInput.setAttribute("aria-label", "표시 종료일");
    endInput.value = (activeRange || dataRange).end;
    endWrap.append(endInput);

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "btn btn-add gantt-range-apply";
    applyBtn.textContent = "적용";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-cancel gantt-range-cancel";
    cancelBtn.textContent = "닫기";

    editor.append(startWrap, endWrap, applyBtn, cancelBtn);
    wrap.append(editor);
  }

  return wrap;
}

// 선택된 프로젝트의 할 일을 간트차트로 렌더링
function renderGantt() {
  ganttEl.innerHTML = "";

  const project = projects.find((p) => p.id === selectedProjectId);
  if (!project) {
    ganttEl.append(ganttMessage("왼쪽에서 프로젝트를 선택하세요."));
    return;
  }

  const all = tasks.filter((t) => t.projectId === selectedProjectId);
  // 시작·종료일이 모두 있고 순서가 올바른 항목만 차트에 표시
  const dated = all.filter(
    (t) => t.startDate && t.endDate && t.endDate >= t.startDate
  );
  const undated = all.length - dated.length;

  if (dated.length === 0) {
    ganttEl.append(
      ganttMessage("기간(시작일·종료일)이 입력된 할 일이 없습니다.")
    );
    return;
  }

  // 종료일 빠른 순 (목록 정렬과 동일 기준)
  dated.sort((a, b) => a.endDate.localeCompare(b.endDate));

  // 데이터에서 도출한 전체 기간 범위 (기간 설정 폼의 기본값)
  let dataMin = dated[0].startDate;
  let dataMax = dated[0].endDate;
  dated.forEach((t) => {
    if (t.startDate < dataMin) dataMin = t.startDate;
    if (t.endDate > dataMax) dataMax = t.endDate;
  });

  // 사용자가 지정한 표시 기간이 있으면 그 범위로, 없으면 데이터 전체 범위로.
  const activeRange = getGanttRange();
  const minStart = activeRange ? activeRange.start : dataMin;
  const maxEnd = activeRange ? activeRange.end : dataMax;

  // 내보내기 헤더에 쓸 표시 기간 라벨 갱신
  ganttRangeLabel = activeRange
    ? `${activeRange.start} ~ ${activeRange.end}`
    : `${minStart} ~ ${maxEnd}`;

  // 표시 기간과 겹치는 할 일만 차트에 표시. 완전히 벗어난 항목은 제외.
  const visibleTasks = dated.filter(
    (t) => !(t.endDate < minStart || t.startDate > maxEnd)
  );
  const hiddenByRange = dated.length - visibleTasks.length;

  // 축 단위: 이 프로젝트에 저장된 값. "auto"면 기간 길이로 자동 선택.
  const selectedUnit = getGanttUnit();
  const unit =
    selectedUnit === "auto" ? pickUnit(minStart, maxEnd) : selectedUnit;
  const periods = buildPeriods(minStart, maxEnd, unit);
  const today = toYMD(new Date());
  const todayIdx = findPeriodIndex(periods, today);

  // 단위 선택기 + 기간 설정 + 안내
  ganttEl.append(
    buildGanttControls({ start: dataMin, end: dataMax }, activeRange)
  );

  // 지정 기간에 표시할 할 일이 하나도 없으면 안내 후 종료 (컨트롤은 위에 남김)
  if (visibleTasks.length === 0) {
    ganttEl.append(
      ganttMessage("선택한 기간에 표시할 할 일이 없습니다. 기간을 조정하세요.")
    );
    return;
  }

  const grid = document.createElement("div");
  grid.className = "gantt-grid";
  // 라벨 열 너비는 프로젝트별 저장값(드래그로 조절). 칸은 가변폭(1fr)이라
  // 라벨 너비를 늘리면 차트 폭이 자동으로 줄어 항상 한 화면에 맞음.
  grid.style.setProperty("--gantt-label", `${getGanttLabelWidth()}px`);
  grid.style.gridTemplateColumns = `var(--gantt-label) repeat(${periods.length}, minmax(0, 1fr))`;

  // 칸이 많으면 라벨이 겹치므로 일정 간격으로만 표시 (최대 ~14개)
  const labelStep = Math.max(1, Math.ceil(periods.length / 14));

  // 헤더 행: 모서리 + 기간 칸. 모서리 우측에 라벨 너비 조절 핸들을 둠.
  const corner = document.createElement("div");
  corner.className = "gantt-corner";
  corner.textContent = "할 일";
  const resizer = document.createElement("div");
  resizer.className = "gantt-resizer";
  resizer.title = "드래그하여 목록 이름 너비 조절";
  resizer.setAttribute("aria-hidden", "true");
  corner.append(resizer);
  grid.append(corner);

  periods.forEach((period, i) => {
    const head = document.createElement("div");
    head.className = "gantt-day-head";
    if (i === todayIdx) head.classList.add("is-today");
    // 주말/공휴일 음영 (일 단위에서만)
    const hol = unit === "day" ? getHolidayName(period.start) : null;
    if (unit === "day") {
      const mark = dayMarkClass(period.start);
      if (mark) head.classList.add(mark);
    }
    // 간격에 해당하거나 오늘 칸이면 라벨 표시, 나머지는 비움
    if (i % labelStep === 0 || i === todayIdx) head.textContent = period.label;
    const range =
      period.start === period.end
        ? period.start
        : `${period.start} ~ ${period.end}`;
    head.title = hol ? `${range} (${hol})` : range;
    grid.append(head);
  });

  // 표시 기간의 양 끝 (막대 클램핑 기준)
  const firstStart = periods[0].start;
  const lastEnd = periods[periods.length - 1].end;

  // 각 할 일 행: 라벨 + 기간 칸(기간만큼 막대)
  visibleTasks.forEach((task) => {
    const label = document.createElement("div");
    label.className = "gantt-rowlabel";
    label.textContent = task.title;
    label.title = `${task.title} (${task.startDate} ~ ${task.endDate})`;
    label.dataset.id = task.id; // 라벨 클릭으로도 수정
    grid.append(label);

    // 표시 기간을 벗어나는 부분은 양 끝 칸으로 클램핑.
    // (잘린 쪽은 둥근 끝 처리를 생략해 기간이 더 이어짐을 나타냄)
    const startVisible = task.startDate >= firstStart;
    const endVisible = task.endDate <= lastEnd;
    const startIdx = startVisible ? findPeriodIndex(periods, task.startDate) : 0;
    const endIdx = endVisible
      ? findPeriodIndex(periods, task.endDate)
      : periods.length - 1;
    const status = task.completed
      ? "done"
      : task.endDate < today
      ? "overdue"
      : "active";

    periods.forEach((period, i) => {
      const cell = document.createElement("div");
      cell.className = "gantt-cell";
      if (i === todayIdx) cell.classList.add("is-today");
      // 주말/공휴일 음영 (일 단위에서만) — 막대 뒤 배경으로 깔림
      if (unit === "day") {
        const mark = dayMarkClass(period.start);
        if (mark) cell.classList.add(mark);
      }
      if (i >= startIdx && i <= endIdx) {
        const bar = document.createElement("div");
        bar.className = `gantt-bar bar-${status}`;
        if (i === startIdx && startVisible) bar.classList.add("bar-start");
        if (i === endIdx && endVisible) bar.classList.add("bar-end");
        bar.title = `${task.title}\n${task.startDate} ~ ${task.endDate}`;
        bar.dataset.id = task.id; // 막대 클릭으로 수정
        cell.append(bar);
      }
      grid.append(cell);
    });
  });

  ganttEl.append(grid);

  // 일 단위일 때 주말/공휴일 범례
  if (unit === "day") {
    const legend = document.createElement("div");
    legend.className = "gantt-legend";
    legend.innerHTML =
      '<span class="lg lg-sat"></span>토 ' +
      '<span class="lg lg-sun"></span>일·공휴일 ' +
      '<span class="lg lg-today"></span>오늘';
    ganttEl.append(legend);
  }

  if (hiddenByRange > 0) {
    ganttEl.append(
      ganttMessage(
        `설정한 표시 기간을 벗어나 숨겨진 할 일 ${hiddenByRange}개가 있습니다.`
      )
    );
  }

  if (undated > 0) {
    ganttEl.append(
      ganttMessage(
        `기간이 비어 차트에 표시되지 않은 할 일 ${undated}개가 있습니다.`
      )
    );
  }
}

// 보기 모드 전환 (목록 / 간트차트)
function setTaskView(view) {
  taskView = view;
  viewTabsEl
    .querySelectorAll(".view-tab")
    .forEach((t) => t.classList.toggle("is-active", t.dataset.view === view));
  taskListEl.classList.toggle("is-hidden", view !== "list");
  listToolbarEl.classList.toggle("is-hidden", view !== "list");
  ganttEl.classList.toggle("is-hidden", view !== "gantt");
}

viewTabsEl.addEventListener("click", (e) => {
  const tab = e.target.closest(".view-tab");
  if (!tab) return;
  setTaskView(tab.dataset.view);
});

// 간트 축 단위 선택 변경
ganttEl.addEventListener("change", (e) => {
  const select = e.target.closest(".gantt-unit-select");
  if (!select || !selectedProjectId) return;
  ganttUnits[selectedProjectId] = select.value;
  saveGanttUnits();
  renderGantt();
});

// 간트 '기간 설정' 컨트롤 처리 (토글/적용/닫기/전체 보기) + 내보내기
ganttEl.addEventListener("click", (e) => {
  if (!selectedProjectId) return;

  const exportBtn = e.target.closest("[data-export]");
  if (exportBtn) {
    exportView("gantt", exportBtn.dataset.export);
    return;
  }

  if (e.target.closest(".gantt-range-toggle")) {
    ganttRangeOpen = !ganttRangeOpen;
    renderGantt();
    return;
  }
  if (e.target.closest(".gantt-range-cancel")) {
    ganttRangeOpen = false;
    renderGantt();
    return;
  }
  if (e.target.closest(".gantt-range-reset")) {
    delete ganttRanges[selectedProjectId];
    saveGanttRanges();
    ganttRangeOpen = false;
    renderGantt();
    return;
  }
  if (e.target.closest(".gantt-range-apply")) {
    const controls = e.target.closest(".gantt-controls");
    const start = controls.querySelector(".gantt-range-start").value;
    const end = controls.querySelector(".gantt-range-end").value;
    if (!start || !end) {
      alert("시작일과 종료일을 모두 입력하세요.");
      return;
    }
    if (end < start) {
      alert("종료일이 시작일보다 빠를 수 없습니다.");
      return;
    }
    ganttRanges[selectedProjectId] = { start, end };
    saveGanttRanges();
    ganttRangeOpen = false;
    renderGantt();
    return;
  }
});

// 라벨 열 너비 드래그 조절. 칸은 1fr이라 라벨 너비만 바꾸면 차트 폭이 자동 조정됨.
ganttEl.addEventListener("mousedown", (e) => {
  const handle = e.target.closest(".gantt-resizer");
  if (!handle || !selectedProjectId) return;
  e.preventDefault();

  const grid = ganttEl.querySelector(".gantt-grid");
  if (!grid) return;

  const startX = e.clientX;
  const startWidth = getGanttLabelWidth();
  let width = startWidth;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  const onMove = (ev) => {
    width = Math.max(
      MIN_LABEL_WIDTH,
      Math.min(MAX_LABEL_WIDTH, startWidth + (ev.clientX - startX))
    );
    grid.style.setProperty("--gantt-label", `${width}px`);
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    ganttLabelWidths[selectedProjectId] = width;
    saveGanttLabelWidths();
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// 간트차트 막대/라벨 클릭 → 목록 보기로 전환 후 해당 할 일 수정 폼 열기
ganttEl.addEventListener("click", (e) => {
  const target = e.target.closest("[data-id]");
  if (!target) return;
  const id = target.dataset.id;
  if (!tasks.some((t) => t.id === id)) return;

  editingTaskId = id;
  setTaskView("list");
  renderTasks();

  // 수정 폼 제목 입력에 포커스 + 화면에 보이게 스크롤
  const titleInput = taskListEl.querySelector(".task-edit-form .edit-task-title");
  if (titleInput) {
    titleInput.focus();
    titleInput.closest(".task-item").scrollIntoView({ block: "nearest" });
  }
});

// 할 일이 표시 기간과 겹치는지 판정. range가 없으면 항상 표시.
// 날짜가 하나라도 있으면 그것으로 겹침을 판정하고, 둘 다 없으면 기간 밖으로 간주.
function taskInRange(task, range) {
  if (!range) return true;
  const s = task.startDate || task.endDate;
  const e = task.endDate || task.startDate;
  if (!s || !e) return false;
  return !(e < range.start || s > range.end);
}

// 선택된 프로젝트의 할 일을 목록으로 렌더링 (목록 보기)
function renderTaskList() {
  const project = projects.find((p) => p.id === selectedProjectId);

  // 헤더 프로젝트명 갱신
  tasksProjectNameEl.textContent = project ? project.name : "선택된 프로젝트 없음";

  // 도구막대(기간 설정·내보내기) 갱신
  renderListToolbar(project);

  taskListEl.innerHTML = "";

  // 선택된 프로젝트가 없으면 안내 문구
  if (!project) {
    listRangeLabel = "";
    const empty = document.createElement("li");
    empty.className = "task-empty";
    empty.textContent = "왼쪽에서 프로젝트를 선택하세요.";
    taskListEl.append(empty);
    return;
  }

  // 종료일 오름차순 정렬 (가장 빠른 마감이 위). 종료일 없는 항목은 맨 아래.
  const all = tasks
    .filter((t) => t.projectId === selectedProjectId)
    .sort((a, b) => {
      if (!a.endDate && !b.endDate) return 0;
      if (!a.endDate) return 1; // a를 아래로
      if (!b.endDate) return -1; // b를 아래로
      return a.endDate.localeCompare(b.endDate); // YYYY-MM-DD 사전순=날짜순
    });

  // 사용자가 지정한 표시 기간이 있으면 그 기간과 겹치는 할 일만 표시.
  const activeRange = getListRange();
  const visible = all.filter((t) => taskInRange(t, activeRange));
  const hiddenByRange = all.length - visible.length;

  // 내보내기 헤더에 쓸 표시 기간 라벨 갱신
  listRangeLabel = activeRange
    ? `${activeRange.start} ~ ${activeRange.end}`
    : "전체 기간";

  if (all.length === 0) {
    const empty = document.createElement("li");
    empty.className = "task-empty";
    empty.textContent = "아직 할 일이 없습니다. 위에서 추가하세요.";
    taskListEl.append(empty);
    return;
  }

  if (visible.length === 0) {
    const empty = document.createElement("li");
    empty.className = "task-empty";
    empty.textContent = "선택한 기간에 표시할 할 일이 없습니다. 기간을 조정하세요.";
    taskListEl.append(empty);
    return;
  }

  visible.forEach((task) => {
    const li = document.createElement("li");
    li.className = "task-item";
    li.dataset.id = task.id;

    if (task.id === editingTaskId) {
      li.append(buildTaskEditForm(task));
    } else {
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "task-check";
      check.setAttribute("aria-label", "완료 여부");
      check.checked = task.completed;

      const body = document.createElement("div");
      body.className = "task-body";

      const title = document.createElement("span");
      title.className = "task-title" + (task.completed ? " is-done" : "");
      title.textContent = task.title;

      const dates = document.createElement("span");
      dates.className = "task-dates";
      dates.textContent = `${task.startDate || "—"} ~ ${task.endDate || "—"}`;

      // 마감 임박/초과 배지
      const due = getDueStatus(task);
      if (due) {
        const dueBadge = document.createElement("span");
        dueBadge.className = `due-badge due-${due.kind}`;
        dueBadge.textContent = due.label;
        dates.append(" ", dueBadge);
      }

      body.append(title, dates);

      const actions = document.createElement("div");
      actions.className = "task-actions";
      const editBtn = document.createElement("button");
      editBtn.className = "icon-btn";
      editBtn.dataset.action = "edit";
      editBtn.title = "수정";
      editBtn.textContent = "✎";
      const delBtn = document.createElement("button");
      delBtn.className = "icon-btn icon-btn-danger";
      delBtn.dataset.action = "delete";
      delBtn.title = "삭제";
      delBtn.textContent = "🗑";
      actions.append(editBtn, delBtn);

      li.append(check, body, actions);
    }

    taskListEl.append(li);
  });

  if (hiddenByRange > 0) {
    const note = document.createElement("li");
    note.className = "list-note";
    note.textContent = `설정한 표시 기간을 벗어나 숨겨진 할 일 ${hiddenByRange}개가 있습니다.`;
    taskListEl.append(note);
  }
}

// 목록 도구막대: 기간 설정(토글·편집·전체 보기) + 내보내기(PNG/PDF) 버튼.
// 선택된 프로젝트가 없으면 비워 둔다.
function renderListToolbar(project) {
  listToolbarEl.innerHTML = "";
  if (!project) return;

  // 기간 설정 편집 폼의 기본값: 이 프로젝트 할 일의 전체 기간
  const dated = tasks.filter(
    (t) =>
      t.projectId === project.id &&
      t.startDate &&
      t.endDate &&
      t.endDate >= t.startDate
  );
  let dataRange = null;
  if (dated.length > 0) {
    let min = dated[0].startDate;
    let max = dated[0].endDate;
    dated.forEach((t) => {
      if (t.startDate < min) min = t.startDate;
      if (t.endDate > max) max = t.endDate;
    });
    dataRange = { start: min, end: max };
  }
  const activeRange = getListRange();
  const fallback = activeRange ||
    dataRange || { start: toYMD(new Date()), end: toYMD(new Date()) };

  // 기간 설정 토글 버튼
  const rangeBtn = document.createElement("button");
  rangeBtn.type = "button";
  rangeBtn.className = "btn btn-cancel list-range-toggle";
  rangeBtn.setAttribute("aria-expanded", String(listRangeOpen));
  rangeBtn.textContent = "기간 설정";
  listToolbarEl.append(rangeBtn);

  // 적용 중인 표시 기간 표시 + 전체 보기 복귀
  if (activeRange) {
    const tag = document.createElement("span");
    tag.className = "gantt-range-tag";
    tag.textContent = `표시 기간: ${activeRange.start} ~ ${activeRange.end}`;

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "gantt-range-reset list-range-reset";
    resetBtn.textContent = "전체 보기";

    listToolbarEl.append(tag, resetBtn);
  }

  // 내보내기 버튼 (PNG / PDF)
  listToolbarEl.append(buildExportButtons("list"));

  // 기간 설정 편집 폼 (토글로 표시)
  if (listRangeOpen) {
    listToolbarEl.append(buildRangeEditor(fallback, "list"));
  }
}

// 내보내기 버튼 묶음: 라벨 + PNG + PDF. view는 "list" | "gantt".
function buildExportButtons(view) {
  const group = document.createElement("span");
  group.className = "export-group";

  const label = document.createElement("span");
  label.className = "export-label";
  label.textContent = "내보내기";

  const png = document.createElement("button");
  png.type = "button";
  png.className = "btn btn-cancel export-btn";
  png.dataset.export = "png";
  png.dataset.exportView = view;
  png.textContent = "PNG";

  const pdf = document.createElement("button");
  pdf.type = "button";
  pdf.className = "btn btn-cancel export-btn";
  pdf.dataset.export = "pdf";
  pdf.dataset.exportView = view;
  pdf.textContent = "PDF";

  group.append(label, png, pdf);
  return group;
}

// 시작·종료일 입력 + 적용/닫기 편집 폼. view별 클래스 접두사를 붙인다.
function buildRangeEditor(defaults, view) {
  const editor = document.createElement("div");
  editor.className = "gantt-range-editor";

  const startWrap = document.createElement("label");
  startWrap.className = "field-label";
  startWrap.append("시작 ");
  const startInput = document.createElement("input");
  startInput.type = "date";
  startInput.className = `input ${view}-range-start`;
  startInput.setAttribute("aria-label", "표시 시작일");
  startInput.value = defaults.start;
  startWrap.append(startInput);

  const endWrap = document.createElement("label");
  endWrap.className = "field-label";
  endWrap.append("종료 ");
  const endInput = document.createElement("input");
  endInput.type = "date";
  endInput.className = `input ${view}-range-end`;
  endInput.setAttribute("aria-label", "표시 종료일");
  endInput.value = defaults.end;
  endWrap.append(endInput);

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = `btn btn-add ${view}-range-apply`;
  applyBtn.textContent = "적용";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = `btn btn-cancel ${view}-range-cancel`;
  cancelBtn.textContent = "닫기";

  editor.append(startWrap, endWrap, applyBtn, cancelBtn);
  return editor;
}

// 할 일 인라인 수정 폼: 제목 + 시작일 + 종료일 + 저장/취소
function buildTaskEditForm(task) {
  const form = document.createElement("form");
  form.className = "task-edit-form";

  const titleInput = document.createElement("input");
  titleInput.className = "input edit-task-title";
  titleInput.type = "text";
  titleInput.value = task.title;
  titleInput.setAttribute("aria-label", "할 일 제목 수정");

  const startInput = document.createElement("input");
  startInput.className = "input edit-task-start";
  startInput.type = "date";
  startInput.value = task.startDate || "";
  startInput.setAttribute("aria-label", "시작일 수정");

  const endInput = document.createElement("input");
  endInput.className = "input edit-task-end";
  endInput.type = "date";
  endInput.value = task.endDate || "";
  endInput.setAttribute("aria-label", "종료일 수정");

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "btn btn-add";
  saveBtn.textContent = "저장";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-cancel";
  cancelBtn.dataset.action = "cancel";
  cancelBtn.textContent = "취소";

  form.append(titleInput, startInput, endInput, saveBtn, cancelBtn);
  return form;
}

// 할 일 수정 적용 (FR-04): 제목/시작일/종료일 변경
function applyTaskEdit(id, li) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;

  const title = li.querySelector(".edit-task-title").value.trim();
  if (!title) return; // 제목 공백 차단

  const startDate = li.querySelector(".edit-task-start").value;
  const endDate = li.querySelector(".edit-task-end").value;

  if (startDate && endDate && endDate < startDate) {
    alert("종료일이 시작일보다 빠를 수 없습니다.");
    return;
  }

  task.title = title;
  task.startDate = startDate;
  task.endDate = endDate;
  editingTaskId = null;
  save();
  renderTasks();
}

// 할 일 삭제 (FR-04): 확인 후 해당 항목만 제거
function deleteTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;

  if (!confirm(`"${task.title}" 할 일을 삭제할까요?`)) return;

  tasks = tasks.filter((t) => t.id !== id);
  if (editingTaskId === id) editingTaskId = null;
  save();
  renderTasks();
  renderProjects(); // 진도율 갱신
}

// 할 일 추가 (FR-03): 제목 + 시작일 + 종료일
taskForm.addEventListener("submit", (e) => {
  e.preventDefault();

  if (!selectedProjectId) {
    alert("먼저 왼쪽에서 프로젝트를 선택하세요.");
    return;
  }

  const title = taskTitleInput.value.trim();
  if (!title) return; // 제목 공백 차단

  const startDate = taskStartInput.value;
  const endDate = taskEndInput.value;

  // 종료일이 시작일보다 빠르면 차단 (둘 다 입력된 경우)
  if (startDate && endDate && endDate < startDate) {
    alert("종료일이 시작일보다 빠를 수 없습니다.");
    return;
  }

  tasks.push(makeTask(selectedProjectId, title, startDate, endDate));
  save();

  taskTitleInput.value = "";
  taskStartInput.value = "";
  taskEndInput.value = "";
  renderTasks();
  renderProjects(); // 진도율(분모) 갱신
});

// 완료 체크 (FR-05): completed 토글
taskListEl.addEventListener("change", (e) => {
  const check = e.target.closest(".task-check");
  if (!check) return;
  const item = check.closest(".task-item");
  if (!item) return;

  const task = tasks.find((t) => t.id === item.dataset.id);
  if (!task) return;

  task.completed = check.checked;
  save();
  renderTasks();
  renderProjects(); // 진도율 즉시 갱신
});

// 할 일 목록 클릭: 수정/삭제/취소 액션
taskListEl.addEventListener("click", (e) => {
  const actionBtn = e.target.closest("[data-action]");
  if (!actionBtn) return;
  const item = actionBtn.closest(".task-item");
  if (!item) return;
  const id = item.dataset.id;

  const action = actionBtn.dataset.action;
  if (action === "edit") {
    editingTaskId = id;
    renderTasks();
  } else if (action === "delete") {
    deleteTask(id);
  } else if (action === "cancel") {
    editingTaskId = null;
    renderTasks();
  }
});

// 할 일 인라인 수정 폼 저장 (submit)
taskListEl.addEventListener("submit", (e) => {
  const form = e.target.closest(".task-edit-form");
  if (!form) return;
  e.preventDefault();
  const item = form.closest(".task-item");
  applyTaskEdit(item.dataset.id, item);
});

// 목록 도구막대 처리 (기간 설정 토글/적용/닫기/전체 보기) + 내보내기
listToolbarEl.addEventListener("click", (e) => {
  const exportBtn = e.target.closest("[data-export]");
  if (exportBtn) {
    exportView("list", exportBtn.dataset.export);
    return;
  }

  if (!selectedProjectId) return;

  if (e.target.closest(".list-range-toggle")) {
    listRangeOpen = !listRangeOpen;
    renderTaskList();
    return;
  }
  if (e.target.closest(".list-range-cancel")) {
    listRangeOpen = false;
    renderTaskList();
    return;
  }
  if (e.target.closest(".list-range-reset")) {
    delete listRanges[selectedProjectId];
    saveListRanges();
    listRangeOpen = false;
    renderTaskList();
    return;
  }
  if (e.target.closest(".list-range-apply")) {
    const start = listToolbarEl.querySelector(".list-range-start").value;
    const end = listToolbarEl.querySelector(".list-range-end").value;
    if (!start || !end) {
      alert("시작일과 종료일을 모두 입력하세요.");
      return;
    }
    if (end < start) {
      alert("종료일이 시작일보다 빠를 수 없습니다.");
      return;
    }
    listRanges[selectedProjectId] = { start, end };
    saveListRanges();
    listRangeOpen = false;
    renderTaskList();
    return;
  }
});

// =====================================================================
// 내보내기: 현재 보기(목록/간트차트)를 PNG·PDF로 저장.
//   외부 라이브러리 없이 브라우저 기본 API만 사용한다.
//   - 화면을 그대로 복제 → 계산된 스타일을 인라인 → 흰 카드(제목·기간)로 감쌈
//   - SVG <foreignObject>로 래스터화 → <canvas> → PNG
//   - PDF는 캔버스를 JPEG로 인코딩해 최소 구조의 PDF에 그림 XObject로 삽입
// =====================================================================

const EXPORT_SCALE = 2; // 선명도를 위해 2배 해상도로 래스터화
const EXPORT_PAD = 16; // 카드 내부 여백(px) — 최소화

// 파일명에 쓸 수 없는 문자를 _ 로 치환
function sanitizeFilename(name) {
  return (name || "export").replace(/[\\/:*?"<>|]/g, "_").trim() || "export";
}

// 라이브 요소의 계산된 스타일을 같은 구조의 복제본에 인라인으로 복사.
// 복제본은 cloneNode(true) 결과여서 라이브와 노드 순서가 1:1로 대응한다.
function inlineStylesFromLive(liveRoot, cloneRoot) {
  const liveEls = [liveRoot, ...liveRoot.querySelectorAll("*")];
  const cloneEls = [cloneRoot, ...cloneRoot.querySelectorAll("*")];
  const n = Math.min(liveEls.length, cloneEls.length);
  for (let i = 0; i < n; i++) {
    const cs = getComputedStyle(liveEls[i]);
    let text = "";
    for (let j = 0; j < cs.length; j++) {
      const prop = cs[j];
      text += `${prop}:${cs.getPropertyValue(prop)};`;
    }
    cloneEls[i].setAttribute("style", text);
  }
}

// 보기 컨텐츠를 흰 카드로 감싼 내보내기용 DOM을 만든다.
function buildExportCard(view, projectName, rangeLabel) {
  let liveContainer;
  if (view === "gantt") {
    if (!ganttEl.querySelector(".gantt-grid")) return null;
    liveContainer = ganttEl;
  } else {
    if (!taskListEl.querySelector(".task-item")) return null;
    liveContainer = taskListEl;
  }

  // 현재 화면 너비를 기준으로 컨텐츠 너비 고정 (간트 1fr 칸이 찌그러지지 않도록)
  const widthRef =
    view === "gantt"
      ? ganttEl.querySelector(".gantt-grid")
      : taskListEl;
  const contentWidth = Math.ceil(widthRef.getBoundingClientRect().width);

  const clone = liveContainer.cloneNode(true);
  inlineStylesFromLive(liveContainer, clone);

  // 체크박스 완료 상태는 속성이 아닌 프로퍼티라 복제에 안 실림 → 직접 반영
  if (view === "list") {
    const liveChecks = liveContainer.querySelectorAll(".task-check");
    const cloneChecks = clone.querySelectorAll(".task-check");
    liveChecks.forEach((c, i) => {
      if (!cloneChecks[i]) return;
      if (c.checked) cloneChecks[i].setAttribute("checked", "checked");
      else cloneChecks[i].removeAttribute("checked");
    });
  }

  // 내보내기에 불필요한 요소 제거 (인라인 후에 제거해야 스타일 대응이 어긋나지 않음)
  if (view === "gantt") {
    clone
      .querySelectorAll(".gantt-controls, .gantt-note, .gantt-resizer")
      .forEach((el) => el.remove());
  } else {
    clone
      .querySelectorAll(".task-actions, .list-note")
      .forEach((el) => el.remove());
  }

  // 복제본 루트의 스크롤/높이 제약 해제 → 전체 내용이 잘리지 않고 펼쳐짐
  clone.style.overflow = "visible";
  clone.style.height = "auto";
  clone.style.maxHeight = "none";
  clone.style.flex = "none";
  clone.style.border = "none";
  clone.style.width = `${contentWidth}px`;
  clone.style.margin = "8px auto 0"; // 가로 중앙 정렬
  clone.classList.remove("is-hidden");

  // 헤더: 제목(프로젝트명) + 기간
  const header = document.createElement("div");
  header.style.textAlign = "center";
  header.style.color = "#1f2430";

  const title = document.createElement("div");
  title.style.fontSize = "18px";
  title.style.fontWeight = "700";
  title.textContent = projectName;

  const period = document.createElement("div");
  period.style.fontSize = "12px";
  period.style.color = "#6b7280";
  period.style.marginTop = "2px";
  period.textContent = `기간: ${rangeLabel || "전체"}`;

  header.append(title, period);

  // 흰 카드 컨테이너 (내용이 곧 이미지 전체 → 상하좌우 중앙·여백 최소)
  const card = document.createElement("div");
  Object.assign(card.style, {
    display: "inline-block",
    boxSizing: "border-box",
    background: "#ffffff",
    padding: `${EXPORT_PAD}px`,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif',
  });
  card.append(header, clone);
  return card;
}

// 카드 DOM을 SVG <foreignObject>로 그려 캔버스로 래스터화. { canvas, cssW, cssH } 반환.
function rasterizeCard(card) {
  return new Promise((resolve, reject) => {
    // 화면 밖에 잠시 붙여 레이아웃을 잡고 크기를 측정
    card.style.position = "fixed";
    card.style.left = "-100000px";
    card.style.top = "0";
    document.body.append(card);
    const rect = card.getBoundingClientRect();
    const cssW = Math.ceil(rect.width);
    const cssH = Math.ceil(rect.height);
    // 측정용 화면 밖 위치 지정을 해제하고 직렬화해야 한다.
    // (이 스타일이 남으면 SVG 안에서 카드가 화면 밖으로 그려져 빈 이미지가 됨)
    card.style.position = "";
    card.style.left = "";
    card.style.top = "";
    const inner = new XMLSerializer().serializeToString(card);
    document.body.removeChild(card);

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cssW * EXPORT_SCALE}" ` +
      `height="${cssH * EXPORT_SCALE}" viewBox="0 0 ${cssW} ${cssH}">` +
      `<foreignObject x="0" y="0" width="${cssW}" height="${cssH}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml">${inner}</div>` +
      `</foreignObject></svg>`;

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = cssW * EXPORT_SCALE;
      canvas.height = cssH * EXPORT_SCALE;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; // 배경 흰색
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      resolve({ canvas, cssW, cssH });
    };
    img.onerror = () => reject(new Error("이미지 변환에 실패했습니다."));
    img.src =
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

// Blob을 파일로 다운로드
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// data URL의 base64 부분을 바이트 배열로 디코드
function dataURLToBytes(dataURL) {
  const bin = atob(dataURL.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// JPEG 한 장을 한 페이지에 채운 최소 구조의 PDF 바이트를 만든다.
//   imgW/imgH: JPEG 픽셀 크기, cssW/cssH: 페이지 환산용 CSS 픽셀 크기
function buildPdf(jpegBytes, imgW, imgH, cssW, cssH) {
  // 96px/inch(화면) → 72pt/inch(PDF): 1px = 0.75pt. 물리적 크기를 합리적으로.
  const pageW = +(cssW * 0.75).toFixed(2);
  const pageH = +(cssH * 0.75).toFixed(2);

  // 문자열을 latin1(1바이트/문자) 바이트로 — PDF 구조부는 모두 ASCII
  const enc = (s) => {
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
    return a;
  };

  const chunks = [];
  let len = 0;
  const offsets = {};
  const push = (data) => {
    const b = typeof data === "string" ? enc(data) : data;
    chunks.push(b);
    len += b.length;
  };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  offsets[1] = len;
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  offsets[2] = len;
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

  offsets[3] = len;
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Contents 5 0 R /Resources << /XObject << /Im0 4 0 R >> >> >>\nendobj\n`
  );

  offsets[4] = len;
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} ` +
      `/Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
      `/Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
  );
  push(jpegBytes);
  push("\nendstream\nendobj\n");

  const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
  offsets[5] = len;
  push(
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`
  );

  const xrefStart = len;
  const count = 6; // 객체 0..5
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  push(xref);
  push(
    `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  );

  // 모든 청크를 하나의 바이트 배열로 합치기
  const out = new Uint8Array(len);
  let pos = 0;
  for (const b of chunks) {
    out.set(b, pos);
    pos += b.length;
  }
  return out;
}

// 메인 진입점: 현재 보기를 format("png"|"pdf")으로 저장
async function exportView(view, format) {
  const project = projects.find((p) => p.id === selectedProjectId);
  if (!project) {
    alert("먼저 왼쪽에서 프로젝트를 선택하세요.");
    return;
  }

  const rangeLabel = view === "gantt" ? ganttRangeLabel : listRangeLabel;
  const card = buildExportCard(view, project.name, rangeLabel);
  if (!card) {
    alert("내보낼 내용이 없습니다.");
    return;
  }

  const viewLabel = view === "gantt" ? "간트차트" : "목록";
  const base = `${sanitizeFilename(project.name)}_${viewLabel}`;

  try {
    const { canvas, cssW, cssH } = await rasterizeCard(card);
    if (format === "png") {
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `${base}.png`);
        else alert("PNG 생성에 실패했습니다.");
      }, "image/png");
    } else {
      const jpeg = dataURLToBytes(canvas.toDataURL("image/jpeg", 0.95));
      const pdf = buildPdf(jpeg, canvas.width, canvas.height, cssW, cssH);
      downloadBlob(new Blob([pdf], { type: "application/pdf" }), `${base}.pdf`);
    }
  } catch (err) {
    console.error("내보내기 실패:", err);
    alert("내보내기에 실패했습니다. 브라우저 콘솔을 확인하세요.");
  }
}

// 최초 렌더링
renderProjects();
renderTasks();
