// 관리 탭 왼쪽 "프로젝트 관리" — 팀 공용 카테고리 추가(관리자 전용).
//
// 이 모듈이 담당하는 것:
//  1) 대상 팀 연동: 오른쪽 '팀 관리'의 팀 선택("team-manage-team-selected")을 그대로 따른다.
//  2) 권한: 그 팀의 관리자(memberships/{uid}_{teamId}.role=="admin")에게만 카테고리 추가 UI 를 보인다.
//  3) 추가: teams/{teamId}.extraCategories 배열에 { id, name, color } 를 append(팀당 최대 2개).
//     - id 는 내부 식별자(extra1/extra2), name 은 표시 이름, color 는 기존/서로와 겹치지 않게 자동 배정.
//     - 저장은 teams 문서 update(보안 규칙상 isTeamAdmin 에게 update 허용).
//  4) 현재 추가된 카테고리 목록 표시(이번 단계에선 삭제·이름변경 없음, 표시만).
//
// DOM 조회는 .manage-projects-col 루트로 한정한다(teamManage.js 의 .manage-team-col 과 분리).

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
  doc,
  onSnapshot,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { describeError } from "./cloudErrors.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const TEAMS = "teams";
const MEMBERSHIPS = "memberships";
const SELECT_EVENT = "team-manage-team-selected"; // teamManage.js 가 알리는 대상 팀
const MAX_EXTRA = 2; // 기본 2개(연구/업무) 외 추가 최대 2개
// 슈퍼관리자 — 어느 팀이든 관리 가능(멤버십이 없어도). 보안 규칙의 isSuperAdmin 과 일치.
const SUPER_ADMIN_UID = "NiNrcxpjoOTfr9dPLvq9jz3L8eK2";

// 기본 팀 카테고리 색상(styles.css 의 --research/--work 와 동일) — 추가 색이 이것과 겹치지 않게 한다.
const BASE_COLORS = ["#8b5cf6", "#3b6ef0"];
// 추가 카테고리에 자동 배정할 색 팔레트(기본색과도, 서로도 겹치지 않도록 순서대로 미사용 색을 고른다).
const EXTRA_PALETTE = ["#20a779", "#f0883b", "#e0457b", "#2bb8c4", "#eab308", "#6366f1"];

const membershipId = (uid, teamId) => `${uid}_${teamId}`;

// ----- DOM 참조 (.manage-projects-col 루트) -----
const root = document.querySelector(".manage-projects-col");
const sectionEl = root.querySelector(".mcat-team");
const teamNameEl = root.querySelector(".mcat-team-name");
const formEl = root.querySelector(".mcat-form");
const nameInput = root.querySelector(".mcat-name-input");
const addBtn = root.querySelector(".mcat-add-btn");
const hintEl = root.querySelector(".mcat-hint");
const msgEl = root.querySelector(".mcat-msg");
const listEl = root.querySelector(".mcat-list");

// ----- 상태 -----
let currentUid = null;
let currentTeamId = null;
let currentTeamName = "";
let myRole = null; // 선택 팀에서의 내 역할
let extraCategories = []; // 선택 팀의 추가 카테고리 [{id,name,color}]
let roleUnsub = null;
let teamDocUnsub = null;

// ----- 메시지 -----
function showMsg(text, isError) {
  msgEl.textContent = text;
  msgEl.classList.toggle("is-error", !!isError);
}
function clearMsg() {
  msgEl.textContent = "";
  msgEl.classList.remove("is-error");
}

// ----- 표시/숨김 -----
function isAdmin() {
  // 그 팀의 admin 이거나, 슈퍼관리자(멤버십 없이도 어느 팀이든 관리 가능)
  return myRole === "admin" || currentUid === SUPER_ADMIN_UID;
}
function updateVisibility() {
  // 관리자이고 대상 팀이 있을 때만 팀 카테고리 관리 UI 노출
  const show = !!currentUid && !!currentTeamId && isAdmin();
  sectionEl.classList.toggle("is-hidden", !show);
}

// ----- 색 자동 배정: 기본색 + 이미 쓰인 추가색을 빼고 팔레트에서 첫 미사용 색 -----
function pickColor() {
  const used = new Set([
    ...BASE_COLORS,
    ...extraCategories.map((c) => (c.color || "").toLowerCase()),
  ]);
  const found = EXTRA_PALETTE.find((c) => !used.has(c.toLowerCase()));
  return found || EXTRA_PALETTE[0];
}

// ----- 다음 내부 id: 기존 id 와 겹치지 않게 extra1/extra2/… -----
function nextId() {
  let n = 1;
  const ids = new Set(extraCategories.map((c) => c.id));
  while (ids.has(`extra${n}`)) n++;
  return `extra${n}`;
}

// ----- 목록 렌더 -----
function renderList() {
  teamNameEl.textContent = currentTeamName || currentTeamId || "—";

  const remaining = MAX_EXTRA - extraCategories.length;
  const full = remaining <= 0;
  nameInput.disabled = full;
  addBtn.disabled = full;
  hintEl.textContent = full
    ? "추가 카테고리가 최대치(2개)에 도달했습니다. 더 추가할 수 없습니다."
    : `기본 카테고리(연구·업무) 외에 팀당 최대 ${MAX_EXTRA}개까지 추가할 수 있습니다. (남은 ${remaining}개)`;
  hintEl.classList.toggle("is-full", full);

  listEl.innerHTML = "";
  if (extraCategories.length === 0) {
    const li = document.createElement("li");
    li.className = "mcat-empty";
    li.textContent = "추가된 카테고리가 없습니다.";
    listEl.append(li);
    return;
  }
  extraCategories.forEach((c) => {
    const li = document.createElement("li");
    li.className = "mcat-item";
    // 프로젝트 목록과 같은 배지(.pcat-badge) 스타일로 표시하고, 색만 자동 배정 색을 인라인으로.
    const badge = document.createElement("span");
    badge.className = "pcat-badge";
    badge.dataset.cat = c.id;
    badge.textContent = c.name || c.id;
    if (c.color) badge.style.background = c.color;
    li.append(badge);
    listEl.append(li);
  });
}

// ----- 카테고리 추가 -----
formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearMsg();
  if (!currentUid || !currentTeamId || !isAdmin()) return; // 방어적
  if (extraCategories.length >= MAX_EXTRA) {
    showMsg("추가 카테고리는 최대 2개까지입니다.", true);
    return;
  }
  const name = nameInput.value.trim();
  if (!name) {
    showMsg("카테고리 이름을 입력하세요.", true);
    return;
  }
  // 중복 이름 방지(기본 카테고리 및 기존 추가 카테고리와)
  const lower = name.toLowerCase();
  if (["연구", "업무"].includes(name)) {
    showMsg("기본 카테고리와 같은 이름은 사용할 수 없습니다.", true);
    return;
  }
  if (extraCategories.some((c) => (c.name || "").toLowerCase() === lower)) {
    showMsg("이미 같은 이름의 카테고리가 있습니다.", true);
    return;
  }

  const newCat = { id: nextId(), name, color: pickColor() };
  const updated = [...extraCategories, newCat];
  try {
    // teams 문서 update — extraCategories 만 갱신(name 등 다른 필드는 건드리지 않음).
    await updateDoc(doc(db, TEAMS, currentTeamId), { extraCategories: updated });
    formEl.reset();
    nameInput.focus();
    showMsg(`'${name}' 카테고리를 추가했습니다.`, false);
    // 목록은 teams 스냅샷이 도착하면 자동 갱신된다.
  } catch (err) {
    console.error("팀 카테고리 추가 실패:", err);
    if (err && err.code === "permission-denied") {
      showMsg(
        "권한이 없습니다. 그 팀의 관리자인지, firestore.rules 가 게시되었는지 확인하세요.",
        true
      );
    } else {
      showMsg("카테고리 추가에 실패했습니다: " + describeError(err), true);
    }
  }
});

// ----- 선택 팀의 teams 문서 구독(추가 카테고리 목록) -----
function subscribeTeamDoc(teamId) {
  if (teamDocUnsub) {
    teamDocUnsub();
    teamDocUnsub = null;
  }
  extraCategories = [];
  currentTeamName = "";
  if (!teamId) {
    renderList();
    return;
  }
  teamDocUnsub = onSnapshot(
    doc(db, TEAMS, teamId),
    (snap) => {
      const data = snap.exists() ? snap.data() : {};
      currentTeamName = data.name || "";
      extraCategories = Array.isArray(data.extraCategories)
        ? data.extraCategories
        : [];
      renderList();
    },
    (err) => {
      console.error("팀 문서 구독 실패:", err);
    }
  );
}

// ----- 선택 팀에서의 내 역할 구독(관리자 여부) -----
function subscribeRole(teamId) {
  if (roleUnsub) {
    roleUnsub();
    roleUnsub = null;
  }
  myRole = null;
  if (!currentUid || !teamId) {
    updateVisibility();
    return;
  }
  roleUnsub = onSnapshot(
    doc(db, MEMBERSHIPS, membershipId(currentUid, teamId)),
    (snap) => {
      myRole = snap.exists() ? snap.data().role || null : null;
      updateVisibility();
    },
    (err) => {
      // 팀 삭제 등으로 본인 멤버십 읽기가 막힐 수 있음 — 조용히 숨김 처리
      console.error("역할 확인 실패:", err);
      myRole = null;
      updateVisibility();
    }
  );
}

// ----- 대상 팀 전환(오른쪽 팀 관리 선택과 연동) -----
function setTeam(teamId) {
  const id = teamId || null;
  if (id === currentTeamId) return;
  currentTeamId = id;
  clearMsg();
  subscribeRole(id);
  subscribeTeamDoc(id);
  updateVisibility();
}

document.addEventListener(SELECT_EVENT, (e) => {
  const id = e.detail ? e.detail.teamId : null;
  setTeam(id);
});

// ----- 인증 상태 -----
onAuthStateChanged(auth, (user) => {
  if (roleUnsub) {
    roleUnsub();
    roleUnsub = null;
  }
  if (teamDocUnsub) {
    teamDocUnsub();
    teamDocUnsub = null;
  }
  currentUid = user ? user.uid : null;
  currentTeamId = null;
  currentTeamName = "";
  myRole = null;
  extraCategories = [];
  clearMsg();
  updateVisibility();
  renderList();
});

// 첫 렌더(로그인 전): 숨김
updateVisibility();
renderList();
