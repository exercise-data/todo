// 팀 세부 할일 (Firestore teamTasks CRUD) — 선택된 팀 프로젝트에 종속. personalTasks 의 팀 버전.
//
// 6단계: 개인용(personalTasks)에서 완성한 기능 일체를 팀 공용에 동일 구현.
//  - 전체 _reference_old 간트차트(축 단위 자동/일/주/월, 한국 공휴일 음영, 라벨 너비 드래그,
//    막대 드래그로 기간 변경), 마감 배지, 종료일 오름차순 목록, 목록·간트 표시기간 필터.
//
// teamTasks 문서: { teamId, projectId, title, startDate("YYYY-MM-DD"), endDate,
//                   completed, createdBy(=내 UID), createdAt }
//  - 추가: 제목 + 시작일 + 종료일. 제목 공백 또는 종료일<시작일이면 차단(개인과 동일).
//  - 읽기: teamId==선택된 팀 이고 projectId==선택된 팀 프로젝트인 것만 onSnapshot.
//  - 완료 체크 / 수정 / 삭제: 팀원이면 가능(보안 규칙과 일치).
//  - 프로젝트 연쇄 삭제는 teamProjects.js(deleteProjectCascade)가 담당한다.
//
// UI 상태(축 단위/라벨 너비/표시기간)는 "팀+프로젝트" 단위(`${teamId}|${projectId}`)로
// localStorage 에 저장한다 — 개인용과 키 네임스페이스(team*)를 분리.
//
// (teamId, projectId)는 teamProjects.js 가 "team-project-selected" 이벤트로 알려준다.
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
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { describeError } from "./cloudErrors.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const COLLECTION = "teamTasks";
const SELECT_EVENT = "team-project-selected";

// ----- DOM 참조 (.team-screen 루트로 한정) -----
const root = document.querySelector(".team-screen");
const detailEl = root.querySelector(".pproj-detail");
const formEl = root.querySelector(".ptask-form");
const titleInput = root.querySelector(".ptask-title-input");
const startInput = root.querySelector(".ptask-start-input");
const endInput = root.querySelector(".ptask-end-input");
const errorEl = root.querySelector(".ptask-error");
const listToolbarEl = root.querySelector(".ptask-list-toolbar");
const listEl = root.querySelector(".ptask-list");
const ganttEl = root.querySelector(".ptask-gantt");
const viewTabsEl = root.querySelector(".ptask-viewtabs");

// ----- 상태 -----
let currentUid = null;
let currentTeamId = null;
let currentProjectId = null;
let unsubscribe = null;
let subKey = null; // 현재 구독 키("teamId|projectId") — 중복 구독 방지
let tasksCache = [];
let editingId = null;
let taskView = "list"; // "list" | "gantt"
let listRangeOpen = false; // 목록 '기간 설정' 편집 폼 열림 여부
let ganttRangeOpen = false; // 간트 '기간 설정' 편집 폼 열림 여부

// 간트 막대 드래그 상태
let ganttPeriods = []; // 마지막 렌더의 축 기간 배열 (드래그 좌표→날짜 변환용)
let ganttAxis = null; // 마지막 렌더의 축 범위 { start, end } (드래그 중 축 고정용)
let ganttDragRange = null; // 드래그 중 축을 고정하는 임시 범위 (있으면 사용자 기간보다 우선)
let ganttDragOrder = null; // 드래그 중 행(할 일) 순서를 고정하는 id 배열 (있으면 정렬 대신 이 순서 사용)
let ganttBarDraggedAt = 0; // 드래그/핸들 조작 종료 시각(ms). 직후 click(수정폼 열림) 억제용

// UI 상태 저장 키: "팀+프로젝트" 단위. 둘 중 하나라도 없으면 null.
function uiKey() {
  return currentTeamId && currentProjectId
    ? `${currentTeamId}|${currentProjectId}`
    : null;
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

// ----- 검증 (팀 프로젝트 할일 = 기간 필수, 개인과 동일) -----
function validate(title, startDate, endDate) {
  if (!title) return "제목을 입력하세요.";
  if (!startDate || !endDate) return "시작일과 종료일을 모두 선택하세요.";
  if (endDate < startDate) return "종료일은 시작일보다 빠를 수 없습니다.";
  return null;
}

// ===== 간트차트 상태: 축 단위·라벨 너비 (팀+프로젝트별 localStorage) =====
const GANTT_UNITS_KEY = "teamGanttUnits";
const GANTT_LABELW_KEY = "teamGanttLabelWidths";
const DEFAULT_LABEL_WIDTH = 150;
const MIN_LABEL_WIDTH = 90;
const MAX_LABEL_WIDTH = 480;

function loadObj(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
let ganttUnits = loadObj(GANTT_UNITS_KEY); // { [teamId|projectId]: "auto"|"day"|"week"|"month" }
let ganttLabelWidths = loadObj(GANTT_LABELW_KEY); // { [teamId|projectId]: px }
function saveGanttUnits() {
  try {
    localStorage.setItem(GANTT_UNITS_KEY, JSON.stringify(ganttUnits));
  } catch {}
}
function saveGanttLabelWidths() {
  try {
    localStorage.setItem(GANTT_LABELW_KEY, JSON.stringify(ganttLabelWidths));
  } catch {}
}
function getUnit() {
  return ganttUnits[uiKey()] || "auto";
}
function getLabelWidth() {
  const w = ganttLabelWidths[uiKey()];
  return typeof w === "number" && w > 0 ? w : DEFAULT_LABEL_WIDTH;
}

// ----- 표시 기간 필터 (목록·간트 각각, 팀+프로젝트별 localStorage) -----
const LIST_RANGES_KEY = "teamListRanges";
const GANTT_RANGES_KEY = "teamGanttRanges";
let listRanges = loadObj(LIST_RANGES_KEY); // { [teamId|projectId]: { start, end } }
let ganttRanges = loadObj(GANTT_RANGES_KEY);
function saveListRanges() {
  try {
    localStorage.setItem(LIST_RANGES_KEY, JSON.stringify(listRanges));
  } catch {}
}
function saveGanttRanges() {
  try {
    localStorage.setItem(GANTT_RANGES_KEY, JSON.stringify(ganttRanges));
  } catch {}
}
function getListRange() {
  const r = listRanges[uiKey()];
  return r && r.start && r.end ? r : null;
}
function getGanttRange() {
  const r = ganttRanges[uiKey()];
  return r && r.start && r.end ? r : null;
}

// 할일이 표시 기간과 겹치는지 판정. range가 없으면 항상 표시.
// 날짜가 하나라도 있으면 그것으로 판정, 둘 다 없으면 기간 밖으로 간주.
function taskInRange(task, range) {
  if (!range) return true;
  const s = task.startDate || task.endDate;
  const e = task.endDate || task.startDate;
  if (!s || !e) return false;
  return !(e < range.start || s > range.end);
}

// 현재 프로젝트 dated 할일의 전체 기간 { start, end } (편집 폼 기본값) — 없으면 null
function dataRangeOf() {
  const dated = tasksCache.filter(
    (t) => t.startDate && t.endDate && t.endDate >= t.startDate
  );
  if (dated.length === 0) return null;
  let min = dated[0].startDate;
  let max = dated[0].endDate;
  dated.forEach((t) => {
    if (t.startDate < min) min = t.startDate;
    if (t.endDate > max) max = t.endDate;
  });
  return { start: min, end: max };
}

// 시작·종료 입력 + 적용/닫기 편집 폼. view = "list" | "gantt" (클래스 접두사).
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

// ----- 날짜 유틸 (원본 _reference_old 이식) -----
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function dayDiff(start, end) {
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  return Math.round((b - a) / 86400000);
}
// YMD에 n일을 더한 YMD (음수 가능)
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + n);
  return toYMD(d);
}
// 전체 기간 길이에 따라 축 단위 자동 선택
function pickUnit(minStart, maxEnd) {
  const span = dayDiff(minStart, maxEnd) + 1;
  if (span <= 45) return "day";
  if (span <= 365) return "week";
  return "month";
}
function startOfWeek(date) {
  const x = new Date(date);
  const offset = (x.getDay() + 6) % 7; // 월=0 ... 일=6
  x.setDate(x.getDate() - offset);
  x.setHours(0, 0, 0, 0);
  return x;
}
// 축 기간 배열 생성: [{ start, end, label }]
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
function findPeriodIndex(periods, ymd) {
  return periods.findIndex((p) => ymd >= p.start && ymd <= p.end);
}

// ----- 한국 공휴일 (원본 이식: 양력 고정 + 음력 2024–2030 + 대체공휴일) -----
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
const LUNAR_HOLIDAYS = {
  2024: [["2024-02-09", "설날"], ["2024-02-10", "설날"], ["2024-02-11", "설날"], ["2024-05-15", "부처님오신날"], ["2024-09-16", "추석"], ["2024-09-17", "추석"], ["2024-09-18", "추석"]],
  2025: [["2025-01-28", "설날"], ["2025-01-29", "설날"], ["2025-01-30", "설날"], ["2025-05-05", "부처님오신날"], ["2025-10-05", "추석"], ["2025-10-06", "추석"], ["2025-10-07", "추석"]],
  2026: [["2026-02-16", "설날"], ["2026-02-17", "설날"], ["2026-02-18", "설날"], ["2026-05-24", "부처님오신날"], ["2026-09-24", "추석"], ["2026-09-25", "추석"], ["2026-09-26", "추석"]],
  2027: [["2027-02-05", "설날"], ["2027-02-06", "설날"], ["2027-02-07", "설날"], ["2027-05-13", "부처님오신날"], ["2027-09-14", "추석"], ["2027-09-15", "추석"], ["2027-09-16", "추석"]],
  2028: [["2028-01-25", "설날"], ["2028-01-26", "설날"], ["2028-01-27", "설날"], ["2028-05-02", "부처님오신날"], ["2028-10-02", "추석"], ["2028-10-03", "추석"], ["2028-10-04", "추석"]],
  2029: [["2029-02-12", "설날"], ["2029-02-13", "설날"], ["2029-02-14", "설날"], ["2029-05-20", "부처님오신날"], ["2029-09-21", "추석"], ["2029-09-22", "추석"], ["2029-09-23", "추석"]],
  2030: [["2030-02-02", "설날"], ["2030-02-03", "설날"], ["2030-02-04", "설날"], ["2030-05-09", "부처님오신날"], ["2030-09-11", "추석"], ["2030-09-12", "추석"], ["2030-09-13", "추석"]],
};
const SUBSTITUTE_ELIGIBLE = new Set([
  "삼일절", "어린이날", "광복절", "개천절", "한글날", "성탄절",
  "설날", "추석", "부처님오신날",
]);
const _holidayCache = {};
function getYearHolidays(year) {
  if (_holidayCache[year]) return _holidayCache[year];
  const map = {};
  const overlaps = new Set();
  const add = (date, name) => {
    if (map[date]) overlaps.add(date);
    else map[date] = name;
  };
  for (const [md, name] of Object.entries(FIXED_HOLIDAYS)) add(`${year}-${md}`, name);
  for (const [date, name] of LUNAR_HOLIDAYS[year] || []) add(date, name);
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
function getHolidayName(ymd) {
  return getYearHolidays(Number(ymd.slice(0, 4)))[ymd] || null;
}
// 날짜의 주말/공휴일 구분 클래스
function dayMarkClass(ymd) {
  if (getHolidayName(ymd)) return "is-holiday";
  const dow = new Date(`${ymd}T00:00:00`).getDay();
  if (dow === 0) return "is-sun";
  if (dow === 6) return "is-sat";
  return "";
}
// 요일 한글 한 글자 (0=일 … 6=토) — 주말/공휴일 음영과 동일한 getDay() 기준을 재사용
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];
function weekdayKo(ymd) {
  return WEEKDAY_KO[new Date(`${ymd}T00:00:00`).getDay()];
}
// 간트 안내 문구 요소
function ganttMessage(text) {
  const p = document.createElement("p");
  p.className = "gantt-note";
  p.textContent = text;
  return p;
}

// 종료일까지 남은 일수(날짜 단위). endDate 없으면 null.
function daysUntil(endDate) {
  if (!endDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(end.getTime())) return null;
  return Math.round((end - today) / 86400000);
}

// 마감 배지: 완료 항목은 표시 안 함. { kind: "overdue"|"soon", label } 또는 null.
//   종료<오늘 → "N일 지남"(overdue), 당일 → "오늘 마감"(soon), 3일 이내 → "D-n"(soon)
function getDueStatus(task) {
  if (task.completed) return null;
  const d = daysUntil(task.endDate);
  if (d === null) return null;
  if (d < 0) return { kind: "overdue", label: `${-d}일 지남` };
  if (d === 0) return { kind: "soon", label: "오늘 마감" };
  if (d <= 3) return { kind: "soon", label: `D-${d}` };
  return null;
}

// ----- 렌더 디스패처: 목록 + 간트 모두 갱신(보기 전환은 표시/숨김만) -----
function renderTeamTasks() {
  renderList();
  renderGantt();
}

// 목록 보기 도구막대: 기간 설정 토글 + 적용 중인 기간 + 전체 보기 리셋 + 편집 폼
function renderListToolbar() {
  listToolbarEl.innerHTML = "";
  if (!currentProjectId) return;

  const activeRange = getListRange();
  const fallback =
    activeRange ||
    dataRangeOf() || { start: toYMD(new Date()), end: toYMD(new Date()) };

  const rangeBtn = document.createElement("button");
  rangeBtn.type = "button";
  rangeBtn.className = "btn btn-cancel list-range-toggle";
  rangeBtn.setAttribute("aria-expanded", String(listRangeOpen));
  rangeBtn.textContent = "기간 설정";
  listToolbarEl.append(rangeBtn);

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

  if (listRangeOpen) {
    listToolbarEl.append(buildRangeEditor(fallback, "list"));
  }
}

// ----- 목록 렌더 -----
function renderList() {
  listEl.innerHTML = "";
  if (!currentUid || !currentTeamId || !currentProjectId) {
    listToolbarEl.innerHTML = ""; // 미선택 시 도구막대도 비움
    return;
  }
  renderListToolbar();

  if (tasksCache.length === 0) {
    const li = document.createElement("li");
    li.className = "task-empty";
    li.textContent = "이 프로젝트에 등록된 할 일이 없습니다. 위에서 추가해 보세요.";
    listEl.append(li);
    return;
  }

  // 종료일 오름차순(사전식 = 날짜순, 가장 빠른 마감이 위). 종료일 없는 항목은 맨 아래.
  const sorted = [...tasksCache].sort((a, b) => {
    if (!a.endDate && !b.endDate) return 0;
    if (!a.endDate) return 1;
    if (!b.endDate) return -1;
    return a.endDate.localeCompare(b.endDate);
  });

  // 표시 기간 필터: 기간과 겹치는 할일만, 벗어난 개수는 아래에 안내
  const range = getListRange();
  const visible = sorted.filter((t) => taskInRange(t, range));
  const hiddenByRange = sorted.length - visible.length;

  if (visible.length === 0) {
    const li = document.createElement("li");
    li.className = "task-empty";
    li.textContent = "선택한 기간에 표시할 할 일이 없습니다. 기간을 조정하세요.";
    listEl.append(li);
    return;
  }

  visible.forEach((task) => {
    const li = document.createElement("li");
    li.className = "task-item";
    li.dataset.id = task.id;

    if (editingId === task.id) {
      li.append(buildEditForm(task));
      listEl.append(li);
      return;
    }

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "task-check";
    check.checked = !!task.completed;
    check.dataset.action = "toggle";
    check.title = "완료 표시";
    check.setAttribute("aria-label", "완료 여부");

    const body = document.createElement("div");
    body.className = "task-body";

    const title = document.createElement("span");
    title.className = "task-title" + (task.completed ? " is-done" : "");
    title.textContent = task.title;
    // 팀 공용: 내가 추가한 할일 표시
    if (task.createdBy === currentUid) {
      const mine = document.createElement("span");
      mine.className = "team-mine-badge";
      mine.textContent = "내가 추가";
      title.append(" ", mine);
    }

    const dates = document.createElement("span");
    dates.className = "task-dates";
    dates.textContent = `${task.startDate || "—"} ~ ${task.endDate || "—"}`;

    // 마감 임박/초과 배지 (미완료만)
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

    li.append(check, body, actions);
    listEl.append(li);
  });

  if (hiddenByRange > 0) {
    const note = document.createElement("li");
    note.className = "list-note";
    note.textContent = `설정한 표시 기간을 벗어나 숨겨진 할 일 ${hiddenByRange}개가 있습니다.`;
    listEl.append(note);
  }
}

// 인라인 수정 폼 (제목·시작일·종료일)
function buildEditForm(task) {
  const form = document.createElement("form");
  form.className = "task-edit-form";
  form.autocomplete = "off";

  const title = document.createElement("input");
  title.type = "text";
  title.className = "input edit-task-title";
  title.value = task.title;
  title.setAttribute("aria-label", "할 일 제목");

  const startLabel = document.createElement("label");
  startLabel.className = "field";
  const startSpan = document.createElement("span");
  startSpan.className = "field-label";
  startSpan.textContent = "시작일";
  const start = document.createElement("input");
  start.type = "date";
  start.className = "input edit-task-start";
  start.value = task.startDate || "";
  startLabel.append(startSpan, start);

  const endLabel = document.createElement("label");
  endLabel.className = "field";
  const endSpan = document.createElement("span");
  endSpan.className = "field-label";
  endSpan.textContent = "종료일";
  const end = document.createElement("input");
  end.type = "date";
  end.className = "input edit-task-end";
  end.value = task.endDate || "";
  endLabel.append(endSpan, end);

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "btn btn-add";
  saveBtn.textContent = "저장";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-cancel";
  cancelBtn.dataset.action = "cancel-edit";
  cancelBtn.textContent = "취소";

  form.append(title, startLabel, endLabel, saveBtn, cancelBtn);
  return form;
}

// ----- 간트차트 렌더 (외부 라이브러리 없이 CSS/JS로) -----
// 축 단위 선택기(+안내) + 기간 설정 토글.
function buildGanttControls() {
  const wrap = document.createElement("div");
  wrap.className = "gantt-controls";

  const label = document.createElement("label");
  label.className = "gantt-control-label";
  label.textContent = "축 단위";
  const select = document.createElement("select");
  select.className = "input gantt-unit-select";
  select.setAttribute("aria-label", "간트 축 단위 선택");
  const current = getUnit();
  [["auto", "자동"], ["day", "일"], ["week", "주"], ["month", "월"]].forEach(
    ([value, text]) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      if (value === current) opt.selected = true;
      select.append(opt);
    }
  );
  label.append(select);

  // 기간 설정 토글
  const rangeBtn = document.createElement("button");
  rangeBtn.type = "button";
  rangeBtn.className = "btn btn-cancel gantt-range-toggle";
  rangeBtn.setAttribute("aria-expanded", String(ganttRangeOpen));
  rangeBtn.textContent = "기간 설정";

  const hint = document.createElement("span");
  hint.className = "gantt-note gantt-hint";
  hint.textContent = "막대·이름을 클릭하면 수정";

  wrap.append(label, rangeBtn, hint);

  // 적용 중인 표시 기간 + 전체 보기 리셋
  const activeRange = getGanttRange();
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

  // 기간 설정 편집 폼 (토글)
  if (ganttRangeOpen) {
    const fallback =
      activeRange ||
      dataRangeOf() || { start: toYMD(new Date()), end: toYMD(new Date()) };
    wrap.append(buildRangeEditor(fallback, "gantt"));
  }

  return wrap;
}

// 선택된 프로젝트의 할일을 간트차트로 렌더 (원본 수준, 드래그 편집 포함)
function renderGantt() {
  ganttEl.innerHTML = "";
  if (!currentUid || !currentTeamId || !currentProjectId) return;

  const all = tasksCache;
  // 시작·종료일이 모두 있고 순서가 올바른 항목만
  const dated = all.filter(
    (t) => t.startDate && t.endDate && t.endDate >= t.startDate
  );
  const undated = all.length - dated.length;

  if (dated.length === 0) {
    ganttEl.append(
      ganttMessage(
        all.length === 0
          ? "이 프로젝트에 할 일이 없습니다. 추가하면 간트차트에 표시됩니다."
          : "기간(시작일·종료일)이 입력된 할 일이 없습니다."
      )
    );
    return;
  }

  // 종료일 빠른 순 (목록과 동일 기준).
  // 단, 막대를 드래그하는 동안에는 순서를 고정(ganttDragOrder)해 행이 실시간 재배치되지
  // 않게 한다. 최종 정렬은 드래그 종료 후 renderTeamTasks()에서 한 번만 적용된다.
  if (ganttDragOrder) {
    const order = ganttDragOrder;
    const rank = (id) => {
      const i = order.indexOf(id);
      return i === -1 ? order.length : i; // 고정 목록에 없는 새 항목은 뒤로
    };
    dated.sort((a, b) => rank(a.id) - rank(b.id));
  } else {
    dated.sort((a, b) => a.endDate.localeCompare(b.endDate));
  }

  let dataMin = dated[0].startDate;
  let dataMax = dated[0].endDate;
  dated.forEach((t) => {
    if (t.startDate < dataMin) dataMin = t.startDate;
    if (t.endDate > dataMax) dataMax = t.endDate;
  });

  // 사용자가 지정한 표시 기간이 있으면 그 범위로, 없으면 데이터 전체 범위로.
  // 단, 막대를 드래그하는 동안에는 축을 ganttDragRange로 고정해 칸이 흔들리지 않게 한다.
  const userRange = getGanttRange();
  const axisRange = ganttDragRange || userRange;
  const minStart = axisRange ? axisRange.start : dataMin;
  const maxEnd = axisRange ? axisRange.end : dataMax;

  // 표시 기간과 겹치는 할일만, 완전히 벗어난 항목은 제외
  const visibleTasks = dated.filter(
    (t) => !(t.endDate < minStart || t.startDate > maxEnd)
  );
  const hiddenByRange = dated.length - visibleTasks.length;

  const selectedUnit = getUnit();
  const unit = selectedUnit === "auto" ? pickUnit(minStart, maxEnd) : selectedUnit;
  const periods = buildPeriods(minStart, maxEnd, unit);
  const today = toYMD(new Date());
  const todayIdx = findPeriodIndex(periods, today);

  // 드래그(좌표→날짜 변환, 축 고정)에서 참조할 현재 축 정보 보관
  ganttPeriods = periods;
  ganttAxis = { start: minStart, end: maxEnd };

  // 컨트롤(단위·기간 설정)은 항상 표시
  ganttEl.append(buildGanttControls());

  // 지정 기간에 표시할 할일이 없으면 안내 후 종료(컨트롤은 위에 남김)
  if (visibleTasks.length === 0) {
    ganttEl.append(
      ganttMessage("선택한 기간에 표시할 할 일이 없습니다. 기간을 조정하세요.")
    );
    return;
  }

  const grid = document.createElement("div");
  grid.className = "gantt-grid";
  // 라벨 열은 프로젝트별 저장 폭, 칸은 1fr → 항상 한 화면(가로 스크롤 없음)
  grid.style.setProperty("--gantt-label", `${getLabelWidth()}px`);
  grid.style.gridTemplateColumns = `var(--gantt-label) repeat(${periods.length}, minmax(0, 1fr))`;

  // 칸이 많으면 라벨이 겹치므로 일정 간격으로만 (최대 ~14개)
  const labelStep = Math.max(1, Math.ceil(periods.length / 14));

  // 헤더 행: 모서리(+라벨 너비 조절 핸들) + 기간 칸
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
    const hol = unit === "day" ? getHolidayName(period.start) : null;
    if (unit === "day") {
      const mark = dayMarkClass(period.start);
      if (mark) head.classList.add(mark);
    }
    // 일/주 단위(자동이 일/주로 펼쳐질 때 포함)에는 요일을 함께 표시. 월 단위는 제외.
    // 좁은 칸에서도 잘리지 않도록 날짜(윗줄)·요일(아랫줄) 두 줄로 세로로 쌓는다.
    if (i % labelStep === 0 || i === todayIdx) {
      if (unit === "month") {
        head.textContent = period.label;
      } else {
        const dateLine = document.createElement("span");
        dateLine.className = "gantt-head-date";
        dateLine.textContent = period.label;
        const dowLine = document.createElement("span");
        dowLine.className = "gantt-head-dow";
        dowLine.textContent = `(${weekdayKo(period.start)})`;
        head.append(dateLine, dowLine);
      }
    }
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

    // 표시 기간을 벗어나는 부분은 양 끝 칸으로 클램핑(잘린 쪽은 둥근 끝 생략)
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
    // 양 끝이 모두 화면 안일 때만 드래그 가능 (잘린 막대는 클릭→수정 폼으로)
    const draggable = startVisible && endVisible;

    periods.forEach((period, i) => {
      const cell = document.createElement("div");
      cell.className = "gantt-cell";
      if (i === todayIdx) cell.classList.add("is-today");
      if (unit === "day") {
        const mark = dayMarkClass(period.start);
        if (mark) cell.classList.add(mark);
      }
      if (i >= startIdx && i <= endIdx) {
        const bar = document.createElement("div");
        bar.className = `gantt-bar bar-${status}`;
        if (draggable) bar.classList.add("is-draggable");
        if (i === startIdx && startVisible) {
          bar.classList.add("bar-start");
          if (draggable) {
            const h = document.createElement("div");
            h.className = "gantt-bar-handle handle-start";
            bar.append(h);
          }
        }
        if (i === endIdx && endVisible) {
          bar.classList.add("bar-end");
          if (draggable) {
            const h = document.createElement("div");
            h.className = "gantt-bar-handle handle-end";
            bar.append(h);
          }
        }
        bar.title = `${task.title}\n${task.startDate} ~ ${task.endDate}`;
        bar.dataset.id = task.id; // 막대 클릭으로 수정, 드래그로 기간 변경
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

// ----- 보기 전환 (목록 / 간트) -----
function setTaskView(view) {
  taskView = view;
  viewTabsEl
    .querySelectorAll(".view-tab")
    .forEach((t) => t.classList.toggle("is-active", t.dataset.ptview === view));
  listEl.classList.toggle("is-hidden", view !== "list");
  listToolbarEl.classList.toggle("is-hidden", view !== "list");
  ganttEl.classList.toggle("is-hidden", view !== "gantt");
}

viewTabsEl.addEventListener("click", (e) => {
  const tab = e.target.closest(".view-tab");
  if (!tab) return;
  setTaskView(tab.dataset.ptview);
});

// ----- 목록 도구막대: 기간 설정 토글/적용/닫기/전체 보기 -----
listToolbarEl.addEventListener("click", (e) => {
  if (!currentProjectId) return;

  if (e.target.closest(".list-range-toggle")) {
    listRangeOpen = !listRangeOpen;
    renderList();
    return;
  }
  if (e.target.closest(".list-range-cancel")) {
    listRangeOpen = false;
    renderList();
    return;
  }
  if (e.target.closest(".list-range-reset")) {
    delete listRanges[uiKey()];
    saveListRanges();
    listRangeOpen = false;
    renderList();
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
    listRanges[uiKey()] = { start, end };
    saveListRanges();
    listRangeOpen = false;
    renderList();
    return;
  }
});

// 축 단위 변경 → 팀+프로젝트별 저장 후 재렌더
ganttEl.addEventListener("change", (e) => {
  const select = e.target.closest(".gantt-unit-select");
  if (!select || !currentProjectId) return;
  ganttUnits[uiKey()] = select.value;
  saveGanttUnits();
  renderGantt();
});

// 라벨 열 너비 드래그 조절 (팀+프로젝트별 저장). 칸은 1fr이라 라벨만 바꿔도 차트 폭 자동 조정.
ganttEl.addEventListener("mousedown", (e) => {
  const handle = e.target.closest(".gantt-resizer");
  if (!handle || !currentProjectId) return;
  e.preventDefault();
  const grid = ganttEl.querySelector(".gantt-grid");
  if (!grid) return;

  const startX = e.clientX;
  const startWidth = getLabelWidth();
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
    ganttLabelWidths[uiKey()] = width;
    saveGanttLabelWidths();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// 간트 막대 드래그로 기간(시작·종료일) 변경.
//   - 가운데를 끌면: 기간 길이를 유지한 채 평행 이동 (축 끝으로 클램핑)
//   - 좌측 핸들: 시작일만 / 우측 핸들: 종료일만
// 날짜는 칸(축 단위) 경계에 스냅. 드래그 중에는 축을 고정하고, 끝나면 teamTasks 업데이트.
ganttEl.addEventListener("mousedown", (e) => {
  const bar = e.target.closest(".gantt-bar.is-draggable");
  if (!bar || !currentProjectId) return;

  const task = tasksCache.find((t) => t.id === bar.dataset.id);
  if (!task) return;

  const grid = ganttEl.querySelector(".gantt-grid");
  const periods = ganttPeriods;
  if (!grid || !periods.length || !ganttAxis) return;

  // 잡은 위치에 따라 모드: 좌/우 핸들이면 한쪽 끝만, 그 외는 전체 이동
  let mode = "move";
  if (e.target.closest(".handle-start")) mode = "start";
  else if (e.target.closest(".handle-end")) mode = "end";

  e.preventDefault();

  // 헤더 칸의 픽셀 경계를 숫자로 캡처 (드래그 중 축 고정이라 재렌더와 무관하게 일정)
  const bounds = [...grid.querySelectorAll(".gantt-day-head")].map((h) => {
    const r = h.getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  const n = bounds.length;
  if (n !== periods.length) return;
  const colAtX = (x) => {
    if (x <= bounds[0].left) return 0;
    if (x >= bounds[n - 1].right) return n - 1;
    for (let i = 0; i < n; i++) {
      if (x >= bounds[i].left && x < bounds[i].right) return i;
    }
    return n - 1;
  };

  const firstStart = periods[0].start;
  const lastEnd = periods[n - 1].end;
  const origStart = task.startDate;
  const origEnd = task.endDate;
  const grabCol = colAtX(e.clientX);

  // 드래그 동안 축 고정 (데이터 변화로 칸이 늘거나 줄지 않도록)
  ganttDragRange = ganttAxis;
  // 드래그 동안 행 순서도 고정 (현재 표시 순서 = 종료일 정렬 순서를 캡처)
  ganttDragOrder = tasksCache
    .filter((t) => t.startDate && t.endDate && t.endDate >= t.startDate)
    .sort((a, b) => a.endDate.localeCompare(b.endDate))
    .map((t) => t.id);
  let moved = false;
  let lastS = origStart;
  let lastE = origEnd;

  document.body.style.cursor = mode === "move" ? "grabbing" : "ew-resize";
  document.body.style.userSelect = "none";

  const apply = (x) => {
    const col = colAtX(x);
    let ns = origStart;
    let ne = origEnd;
    if (mode === "move") {
      // 잡은 칸 대비 이동량(일)을 계산해 기간 길이를 유지한 채 평행 이동
      let delta = dayDiff(periods[grabCol].start, periods[col].start);
      const fwd = dayDiff(origEnd, lastEnd); // 종료가 축 끝까지 갈 여유(>=0)
      const back = -dayDiff(firstStart, origStart); // 시작이 축 처음까지(<=0)
      delta = Math.max(back, Math.min(fwd, delta));
      ns = addDays(origStart, delta);
      ne = addDays(origEnd, delta);
    } else if (mode === "start") {
      ns = periods[col].start;
      if (ns > origEnd) ns = origEnd; // 시작이 종료를 넘지 않도록
    } else {
      ne = periods[col].end;
      if (ne < origStart) ne = origStart; // 종료가 시작보다 앞서지 않도록
    }
    if (ns !== lastS || ne !== lastE) {
      lastS = ns;
      lastE = ne;
      moved = true;
      // 낙관적 갱신: 캐시를 바로 바꾸고 재렌더 (칸 경계를 넘을 때만 호출됨)
      task.startDate = ns;
      task.endDate = ne;
      renderGantt();
    }
  };

  const onMove = (ev) => apply(ev.clientX);
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    ganttDragRange = null; // 축 고정 해제 (다음 렌더부터 정상 범위)
    ganttDragOrder = null; // 순서 고정 해제 → 이후 렌더에서 종료일 기준 재정렬

    if (moved) {
      ganttBarDraggedAt = Date.now(); // 뒤따르는 click(수정 폼 열기) 억제
      renderTeamTasks(); // 실제 축으로 다시 그림
      // Firestore 반영. 실패 시 낙관적 변경을 되돌린다.
      updateDoc(doc(db, COLLECTION, task.id), {
        startDate: lastS,
        endDate: lastE,
      })
        .then(() => clearMessage())
        .catch((err) => {
          console.error("기간 변경 저장 실패:", err);
          task.startDate = origStart;
          task.endDate = origEnd;
          renderTeamTasks();
          showError("기간 변경 저장에 실패했습니다: " + describeError(err));
        });
    } else if (mode !== "move") {
      // 핸들을 눌렀다 떼기만 한 경우: 수정 폼은 열지 않음
      ganttBarDraggedAt = Date.now();
    }
    // 가운데 단순 클릭(이동 없음): 곧이어 click이 수정 폼을 연다
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// 간트 컨트롤(기간 설정) + 막대/라벨 클릭(→ 수정)
ganttEl.addEventListener("click", (e) => {
  if (!currentProjectId) return;

  // --- 기간 설정 토글/적용/닫기/전체 보기 ---
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
    delete ganttRanges[uiKey()];
    saveGanttRanges();
    ganttRangeOpen = false;
    renderGantt();
    return;
  }
  if (e.target.closest(".gantt-range-apply")) {
    const start = ganttEl.querySelector(".gantt-range-start").value;
    const end = ganttEl.querySelector(".gantt-range-end").value;
    if (!start || !end) {
      alert("시작일과 종료일을 모두 입력하세요.");
      return;
    }
    if (end < start) {
      alert("종료일이 시작일보다 빠를 수 없습니다.");
      return;
    }
    ganttRanges[uiKey()] = { start, end };
    saveGanttRanges();
    ganttRangeOpen = false;
    renderGantt();
    return;
  }

  // --- 막대/라벨 클릭 → 목록 보기로 전환 후 수정 폼 열기 ---
  // 직전(350ms 이내)에 드래그/핸들 조작이 있었으면 이 클릭은 무시 (자동 만료)
  if (ganttBarDraggedAt && Date.now() - ganttBarDraggedAt < 350) {
    ganttBarDraggedAt = 0;
    return;
  }
  const target = e.target.closest("[data-id]");
  if (!target) return;
  const id = target.dataset.id;
  if (!tasksCache.some((t) => t.id === id)) return;

  editingId = id;
  setTaskView("list");
  renderTeamTasks();

  const titleInput = listEl.querySelector(".task-edit-form .edit-task-title");
  if (titleInput) {
    titleInput.focus();
    titleInput.closest(".task-item").scrollIntoView({ block: "nearest" });
  }
});

// ----- 추가 -----
formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUid) {
    showError("로그인 후 이용할 수 있습니다.");
    return;
  }
  if (!currentTeamId || !currentProjectId) {
    showError("먼저 팀과 프로젝트를 선택하세요.");
    return;
  }
  const title = titleInput.value.trim();
  const startDate = startInput.value;
  const endDate = endInput.value;

  const err = validate(title, startDate, endDate);
  if (err) {
    showError(err);
    return;
  }

  try {
    await addDoc(collection(db, COLLECTION), {
      teamId: currentTeamId,
      projectId: currentProjectId,
      title,
      startDate,
      endDate,
      completed: false,
      createdBy: currentUid,
      createdAt: serverTimestamp(),
    });
    formEl.reset();
    titleInput.focus();
    clearMessage();
  } catch (e2) {
    console.error("팀 세부 할일 추가 실패:", e2);
    showError("추가에 실패했습니다: " + describeError(e2));
  }
});

// ----- 목록 영역 이벤트(위임): 토글/수정/삭제/취소 -----
listEl.addEventListener("click", async (e) => {
  const actionEl = e.target.closest("[data-action]");
  if (!actionEl) return;
  const li = e.target.closest(".task-item");
  if (!li) return;
  const id = li.dataset.id;
  const action = actionEl.dataset.action;

  if (action === "toggle") {
    const task = tasksCache.find((t) => t.id === id);
    if (!task) return;
    try {
      await updateDoc(doc(db, COLLECTION, id), { completed: !task.completed });
      clearMessage();
    } catch (err) {
      console.error("완료 상태 변경 실패:", err);
      showError("완료 상태 변경에 실패했습니다.");
    }
  } else if (action === "edit") {
    editingId = id;
    clearMessage();
    renderTeamTasks();
  } else if (action === "cancel-edit") {
    editingId = null;
    clearMessage();
    renderTeamTasks();
  } else if (action === "delete") {
    if (!confirm("이 할 일을 삭제할까요?")) return;
    try {
      await deleteDoc(doc(db, COLLECTION, id));
      clearMessage();
    } catch (err) {
      console.error("삭제 실패:", err);
      showError("삭제에 실패했습니다.");
    }
  }
});

// 인라인 수정 폼 저장
listEl.addEventListener("submit", async (e) => {
  const form = e.target.closest(".task-edit-form");
  if (!form) return;
  e.preventDefault();
  const li = e.target.closest(".task-item");
  if (!li) return;
  const id = li.dataset.id;

  const title = form.querySelector(".edit-task-title").value.trim();
  const startDate = form.querySelector(".edit-task-start").value;
  const endDate = form.querySelector(".edit-task-end").value;

  const err = validate(title, startDate, endDate);
  if (err) {
    showError(err);
    return;
  }

  try {
    await updateDoc(doc(db, COLLECTION, id), { title, startDate, endDate });
    editingId = null;
    clearMessage();
    // onSnapshot 만 믿지 않고 직접 재렌더 — 수정 폼(저장/취소)이 닫히지 않는 문제 방지.
    renderTeamTasks();
  } catch (e2) {
    console.error("수정 실패:", e2);
    showError("수정에 실패했습니다: " + describeError(e2));
  }
});

// ----- 선택된 팀 프로젝트의 세부 할일 실시간 구독 -----
function subscribe(teamId, projectId) {
  const q = query(
    collection(db, COLLECTION),
    where("teamId", "==", teamId),
    where("projectId", "==", projectId)
  );
  unsubscribe = onSnapshot(
    q,
    (snap) => {
      tasksCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderTeamTasks();
    },
    (err) => {
      console.error("팀 세부 할일 구독 실패:", err);
      showError(
        "할 일을 불러오지 못했습니다. 보안 규칙/소속을 확인하세요: " +
          describeError(err)
      );
    }
  );
}

// 현재 팀/프로젝트 조합으로 구독을 갱신(불필요한 재구독은 건너뜀).
function resubscribe() {
  const hasTarget = !!(currentUid && currentTeamId && currentProjectId);
  detailEl.classList.toggle("has-project", hasTarget);

  const key = hasTarget ? `${currentTeamId}|${currentProjectId}` : null;
  if (key === subKey) return; // 변화 없음
  subKey = key;

  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  tasksCache = [];
  editingId = null;
  listRangeOpen = false; // 프로젝트가 바뀌면 기간 편집 폼은 닫힌 상태로
  ganttRangeOpen = false;
  clearMessage();

  if (hasTarget) {
    subscribe(currentTeamId, currentProjectId);
  } else {
    renderTeamTasks();
  }
}

// ----- 선택 변경 수신(teamProjects.js 발행) -----
document.addEventListener(SELECT_EVENT, (e) => {
  const teamId = (e.detail && e.detail.teamId) || null;
  const projectId = (e.detail && e.detail.projectId) || null;
  if (teamId === currentTeamId && projectId === currentProjectId) return;
  currentTeamId = teamId;
  currentProjectId = projectId;
  resubscribe();
});

// ----- 인증 상태 -----
onAuthStateChanged(auth, (user) => {
  currentUid = user ? user.uid : null;
  if (!user) {
    currentTeamId = null;
    currentProjectId = null;
  }
  resubscribe();
});

// 첫 렌더(선택 전: CSS가 폼/목록을 숨기고 안내만 표시)
renderTeamTasks();
