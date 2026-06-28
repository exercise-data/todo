// 5단계: 관리자 — 팀원 추가와 권한 부여.
//
// 선택된 팀에 대한 내 membership.role 이 "admin" 이면 팀 관리 영역을 보여 준다(아니면 숨김).
//  - 팀원 목록: 선택된 팀의 memberships 를 읽어 UID·역할 표시.
//  - 팀원 추가: 대상 UID + 역할(admin/member) → memberships 문서를 "{uid}_{teamId}" id 로 생성.
//  - 역할 변경 / 팀원 제거(확인 후).
//  - 모든 쓰기는 관리자만 가능(보안 규칙이 강제). 실패 시 안내 메시지.
//
// ★ memberships 문서 id 규칙은 "{uid}_{teamId}" 이며, 보안 규칙의 isTeamMember/isTeamAdmin 과 일치한다.
//   첫 관리자는 콘솔에서 직접 시드해야 한다(부트스트랩).
//
// 선택된 팀은 teamProjects.js 가 "team-project-selected" 이벤트로 알려준다(teamId 만 사용).

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
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { describeError } from "./cloudErrors.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const MEMBERSHIPS = "memberships";
const SELECT_EVENT = "team-project-selected";

// 문서 id 규칙: "{uid}_{teamId}"
const membershipId = (uid, teamId) => `${uid}_${teamId}`;

// ----- DOM 참조 (.team-screen 루트로 한정) -----
const root = document.querySelector(".team-screen");
const adminPanel = root.querySelector(".team-admin");
const toggleEl = root.querySelector(".team-admin-toggle");
const formEl = root.querySelector(".team-admin-form");
const uidInput = root.querySelector(".ta-uid-input");
const roleSelect = root.querySelector(".ta-role-select");
const errorEl = root.querySelector(".team-admin-error");
const listEl = root.querySelector(".team-admin-list");

// ----- 상태 -----
let currentUid = null;
let currentTeamId = null;
let myRole = null;
let myTeamName = "";
let roleUnsub = null; // 내 membership(역할) 구독
let membersUnsub = null; // 팀 전체 명단 구독
let membersCache = [];

// ----- 메시지 -----
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove("is-info");
}
function showInfo(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add("is-info");
}
function clearMessage() {
  errorEl.textContent = "";
  errorEl.classList.remove("is-info");
}

function showPanel() {
  adminPanel.classList.remove("is-hidden");
}
function hidePanel() {
  adminPanel.classList.add("is-hidden");
}

// ----- 팀원 목록 렌더 -----
function renderMembers() {
  listEl.innerHTML = "";
  if (myRole !== "admin") return;

  if (membersCache.length === 0) {
    const li = document.createElement("li");
    li.className = "task-empty";
    li.textContent = "구성원이 없습니다.";
    listEl.append(li);
    return;
  }

  // 관리자 먼저, 그다음 uid 순
  const sorted = [...membersCache].sort((a, b) => {
    if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
    return (a.uid || "").localeCompare(b.uid || "");
  });

  sorted.forEach((m) => {
    const li = document.createElement("li");
    li.className = "ta-member";
    li.dataset.id = m.id;
    li.dataset.uid = m.uid || "";

    const uid = document.createElement("code");
    uid.className = "ta-member-uid";
    uid.textContent = m.uid || "(uid 없음)";
    if (m.uid === currentUid) {
      const you = document.createElement("span");
      you.className = "ta-you-badge";
      you.textContent = "나";
      uid.append(" ", you);
    }

    const role = document.createElement("select");
    role.className = "input ta-member-role";
    role.setAttribute("aria-label", "역할 변경");
    ["member", "admin"].forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = r;
      if (r === m.role) opt.selected = true;
      role.append(opt);
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn btn-cancel";
    removeBtn.dataset.action = "remove";
    removeBtn.textContent = "제거";

    li.append(uid, role, removeBtn);
    listEl.append(li);
  });
}

// ----- 팀원 추가 -----
formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (myRole !== "admin" || !currentTeamId) {
    showError("관리자만 팀원을 추가할 수 있습니다.");
    return;
  }
  const uid = uidInput.value.trim();
  const role = roleSelect.value;
  if (!uid) {
    showError("추가할 사용자 UID를 입력하세요.");
    return;
  }
  if (uid === currentUid) {
    showError("본인은 이미 이 팀의 구성원입니다.");
    return;
  }

  const data = { uid, teamId: currentTeamId, role };
  if (myTeamName) data.teamName = myTeamName; // 팀 이름을 알면 함께 저장(선택)

  try {
    await setDoc(doc(db, MEMBERSHIPS, membershipId(uid, currentTeamId)), data);
    formEl.reset();
    uidInput.focus();
    showInfo("팀원을 추가했습니다.");
  } catch (err) {
    console.error("팀원 추가 실패:", err);
    showError(
      "추가에 실패했습니다(관리자 권한/UID 확인): " + describeError(err)
    );
  }
});

// ----- 역할 변경 -----
listEl.addEventListener("change", async (e) => {
  const sel = e.target.closest(".ta-member-role");
  if (!sel) return;
  const li = e.target.closest(".ta-member");
  if (!li) return;
  try {
    await updateDoc(doc(db, MEMBERSHIPS, li.dataset.id), { role: sel.value });
    showInfo("역할을 변경했습니다.");
  } catch (err) {
    console.error("역할 변경 실패:", err);
    showError("역할 변경에 실패했습니다: " + describeError(err));
    renderMembers(); // 실패 시 선택값 원복
  }
});

// ----- 팀원 제거 -----
listEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action='remove']");
  if (!btn) return;
  const li = e.target.closest(".ta-member");
  if (!li) return;
  const selfWarn =
    li.dataset.uid === currentUid
      ? "\n(본인을 제거하면 이 팀의 관리 권한을 잃습니다.)"
      : "";
  if (!confirm("이 팀원을 제거할까요?" + selfWarn)) return;
  try {
    await deleteDoc(doc(db, MEMBERSHIPS, li.dataset.id));
    showInfo("팀원을 제거했습니다.");
  } catch (err) {
    console.error("제거 실패:", err);
    showError("제거에 실패했습니다: " + describeError(err));
  }
});

// ----- 팀 전체 명단 구독 (관리자만) -----
function subscribeMembers(teamId) {
  if (membersUnsub) {
    membersUnsub();
    membersUnsub = null;
  }
  const q = query(collection(db, MEMBERSHIPS), where("teamId", "==", teamId));
  membersUnsub = onSnapshot(
    q,
    (snap) => {
      membersCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderMembers();
    },
    (err) => {
      console.error("팀원 목록 구독 실패:", err);
      showError("팀원 목록을 불러오지 못했습니다: " + describeError(err));
    }
  );
}

// ----- 내 역할 확인 → 관리 영역 표시/숨김 -----
function evaluate() {
  if (roleUnsub) {
    roleUnsub();
    roleUnsub = null;
  }
  if (membersUnsub) {
    membersUnsub();
    membersUnsub = null;
  }
  myRole = null;
  myTeamName = "";
  membersCache = [];
  clearMessage();

  if (!currentUid || !currentTeamId) {
    hidePanel();
    renderMembers();
    return;
  }

  // 내 membership 문서를 구독해 역할(및 팀 이름)을 실시간 확인
  const myRef = doc(db, MEMBERSHIPS, membershipId(currentUid, currentTeamId));
  roleUnsub = onSnapshot(
    myRef,
    (snap) => {
      myRole = snap.exists() ? snap.data().role || null : null;
      myTeamName = snap.exists() ? snap.data().teamName || "" : "";
      if (myRole === "admin") {
        showPanel();
        subscribeMembers(currentTeamId);
      } else {
        hidePanel();
        if (membersUnsub) {
          membersUnsub();
          membersUnsub = null;
        }
        membersCache = [];
        renderMembers();
      }
    },
    (err) => {
      console.error("내 역할 확인 실패:", err);
      hidePanel();
    }
  );
}

// ----- 접기/펼치기(아코디언) — 표시 방식만. 데이터/권한 동작과 무관 -----
// 펼침/접힘 상태를 localStorage 에 저장해 새로고침 후에도 유지(기본: 접힘).
const OPEN_KEY = "teamAdminOpen";
function loadOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
function saveOpen(open) {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {}
}
function applyOpenState(open) {
  adminPanel.classList.toggle("is-open", open);
  toggleEl.setAttribute("aria-expanded", String(open));
}
function setOpen(open) {
  applyOpenState(open);
  saveOpen(open);
}
// 클릭/탭으로 토글
toggleEl.addEventListener("click", () => {
  setOpen(!adminPanel.classList.contains("is-open"));
});
// 키보드(Enter/Space)로 토글 — role=button 접근성
toggleEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  setOpen(!adminPanel.classList.contains("is-open"));
});
// 초기 상태 복원(로그인/권한과 무관하게 표시 상태만 적용)
applyOpenState(loadOpen());

// ----- 팀 선택 변경 수신(teamId 변경 시에만 재평가) -----
document.addEventListener(SELECT_EVENT, (e) => {
  const teamId = (e.detail && e.detail.teamId) || null;
  if (teamId === currentTeamId) return;
  currentTeamId = teamId;
  evaluate();
});

// ----- 인증 상태 -----
onAuthStateChanged(auth, (user) => {
  currentUid = user ? user.uid : null;
  if (!user) currentTeamId = null;
  evaluate();
});

// 첫 상태(로그인 전): 숨김
hidePanel();
