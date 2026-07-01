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
// 선택된 팀은 '팀 관리' 탭의 teamManage.js 가 "team-manage-team-selected" 이벤트로 알려준다(teamId 만 사용).
// (이 모듈의 DOM·기능은 5단계에 '팀 공용' 탭에 있었으나 10단계에서 '팀 관리' 탭으로 이동했다.)

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
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { describeError } from "./cloudErrors.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const MEMBERSHIPS = "memberships";
const JOIN_REQUESTS = "joinRequests";
// '팀 관리' 탭의 팀 선택(teamManage.js)이 알려주는 이벤트로 전환(기존 team-project-selected 대신)
const SELECT_EVENT = "team-manage-team-selected";
// 슈퍼관리자(특정 UID) — teamManage.js 와 동일. 팀 삭제 중 본인 멤버십이 사라져도
// "역할 재확인 실패"를 치명 오류로 다루지 않기 위해 사용(권한 판단은 멤버십이 아닌 UID 기준).
const SUPER_ADMIN_UID = "NiNrcxpjoOTfr9dPLvq9jz3L8eK2";

// 문서 id 규칙: "{uid}_{teamId}"
const membershipId = (uid, teamId) => `${uid}_${teamId}`;

// ----- DOM 참조 (.team-manage-screen 루트로 한정 — '팀 관리' 탭으로 이동) -----
const root = document.querySelector(".team-manage-screen");
const adminPanel = root.querySelector(".team-admin");
const toggleEl = root.querySelector(".team-admin-toggle");
const formEl = root.querySelector(".team-admin-form");
const uidInput = root.querySelector(".ta-uid-input");
const roleSelect = root.querySelector(".ta-role-select");
// UID로 팀원 추가 안내문 — 폼과 함께 슈퍼관리자에게만 노출
const hintEl = root.querySelector(".team-admin-hint");
const errorEl = root.querySelector(".team-admin-error");
const listEl = root.querySelector(".team-admin-list");
// 가입 신청 현황(독립 아코디언 패널)
const reqPanel = root.querySelector(".team-requests");
const reqToggleEl = root.querySelector(".team-requests-toggle");
const reqCountEl = root.querySelector(".team-requests-count");
const reqListEl = root.querySelector(".ta-requests-list");

// ----- 상태 -----
let currentUid = null;
let currentTeamId = null;
let myRole = null;
let myTeamName = "";
let roleUnsub = null; // 내 membership(역할) 구독
let membersUnsub = null; // 팀 전체 명단 구독
let membersCache = [];
let requestsUnsub = null; // 가입 신청(pending) 구독
let requestsCache = [];

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
  // "팀 관리" 와 "가입 신청 현황"(독립 아코디언) 둘 다 관리자에게만 노출
  adminPanel.classList.remove("is-hidden");
  reqPanel.classList.remove("is-hidden");
  // "UID로 팀원 추가"(폼+안내문)는 슈퍼관리자 전용 — 일반 팀 관리자에겐 숨긴다.
  // (일반 팀원은 가입 신청-승인으로 받고, 슈퍼관리자만 새 팀 첫 관리자 지정용으로 사용.)
  const superOnly = currentUid === SUPER_ADMIN_UID;
  if (formEl) formEl.classList.toggle("is-hidden", !superOnly);
  if (hintEl) hintEl.classList.toggle("is-hidden", !superOnly);
}
function hidePanel() {
  adminPanel.classList.add("is-hidden");
  reqPanel.classList.add("is-hidden");
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

  // 관리자 먼저, 그다음 이름(없으면 이메일·UID) 순
  const sorted = [...membersCache].sort((a, b) => {
    if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
    const an = a.displayName || a.email || a.uid || "";
    const bn = b.displayName || b.email || b.uid || "";
    return an.localeCompare(bn, "ko");
  });

  sorted.forEach((m) => {
    const li = document.createElement("li");
    li.className = "ta-member";
    li.dataset.id = m.id;
    li.dataset.uid = m.uid || "";

    // 이름 (이메일) — memberships 의 displayName·email 사용. UID 는 평소 크게 노출하지 않음.
    const ident = document.createElement("div");
    ident.className = "ta-member-ident";

    const displayName = m.displayName || "";
    const email = m.email || "";

    const nameSpan = document.createElement("span");
    nameSpan.className = "ta-member-name";
    nameSpan.textContent =
      !displayName && !email
        ? "(이름 미등록)" // 예외: 이름·이메일이 없는 멤버십도 화면이 깨지지 않게 안전 표시
        : displayName || "(이름 없음)";
    ident.append(nameSpan);

    if (email) {
      const emailSpan = document.createElement("span");
      emailSpan.className = "ta-member-email";
      emailSpan.textContent = ` (${email})`;
      ident.append(emailSpan);
    }

    if (m.uid === currentUid) {
      const you = document.createElement("span");
      you.className = "ta-you-badge";
      you.textContent = "나";
      ident.append(" ", you);
    }

    // 필요 시 그 팀원의 UID 를 복사(작은 버튼). 평소에는 UID 를 노출하지 않는다.
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn btn-cancel ta-uid-copy";
    copyBtn.dataset.action = "copy-uid";
    copyBtn.title = "이 팀원의 UID 복사";
    copyBtn.textContent = "UID 복사";

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

    li.append(ident, copyBtn, role, removeBtn);
    listEl.append(li);
  });
}

// UID 복사(클립보드) — 막힌 환경 대비 폴백 포함
async function copyUidText(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error("UID 복사 실패:", err);
  }
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = "복사됨";
    setTimeout(() => {
      btn.textContent = prev;
    }, 1200);
  }
}

// ----- 팀원 UID 복사 -----
listEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action='copy-uid']");
  if (!btn) return;
  const li = e.target.closest(".ta-member");
  if (!li) return;
  copyUidText(li.dataset.uid, btn);
});

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

// ===== 9단계: 가입 신청 처리 (관리자) =====

// 신청 시각(밀리초) — 정렬용
function reqMillis(r) {
  const ts = r.createdAt;
  if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  return Infinity;
}
// Firestore Timestamp → 사람이 읽는 시각
function formatTs(ts) {
  if (ts && typeof ts.toDate === "function") {
    try {
      return ts.toDate().toLocaleString("ko-KR");
    } catch {
      return "-";
    }
  }
  return "-";
}

// ----- 대기 중 신청 목록 렌더 (관리자만) -----
function renderRequests() {
  reqListEl.innerHTML = "";
  // 접힌 상태에서도 대기 건수를 알 수 있게 제목 옆 배지 갱신(표시 전용)
  if (reqCountEl) {
    const n = myRole === "admin" ? requestsCache.length : 0;
    reqCountEl.textContent = n > 0 ? String(n) : "";
  }
  if (myRole !== "admin") return;

  if (requestsCache.length === 0) {
    const li = document.createElement("li");
    li.className = "task-empty";
    li.textContent = "대기 중인 신청이 없습니다.";
    reqListEl.append(li);
    return;
  }

  // 오래된 신청 먼저(신청 시각 오름차순)
  const sorted = [...requestsCache].sort((a, b) => reqMillis(a) - reqMillis(b));

  sorted.forEach((r) => {
    const li = document.createElement("li");
    li.className = "ta-req";
    li.dataset.id = r.id;
    li.dataset.uid = r.uid || "";

    const info = document.createElement("div");
    info.className = "ta-req-info";

    const name = document.createElement("div");
    name.className = "ta-req-name";
    name.textContent = r.displayName || "(이름 없음)";

    const email = document.createElement("div");
    email.className = "ta-req-email";
    email.textContent = r.email || "(이메일 없음)";

    const msg = document.createElement("div");
    msg.className = "ta-req-message";
    if (r.message) {
      msg.textContent = r.message;
    } else {
      msg.textContent = "(사유 없음)";
      msg.classList.add("is-empty");
    }

    const time = document.createElement("div");
    time.className = "ta-req-time";
    time.textContent = "신청: " + formatTs(r.createdAt);

    info.append(name, email, msg, time);

    const actions = document.createElement("div");
    actions.className = "ta-req-actions";

    const approveBtn = document.createElement("button");
    approveBtn.type = "button";
    approveBtn.className = "btn btn-add";
    approveBtn.dataset.action = "approve";
    approveBtn.textContent = "승인";

    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.className = "btn btn-cancel";
    rejectBtn.dataset.action = "reject";
    rejectBtn.textContent = "거절";

    actions.append(approveBtn, rejectBtn);

    li.append(info, actions);
    reqListEl.append(li);
  });
}

// ----- 현재 팀의 대기 중 신청 구독 (관리자만) -----
function subscribeRequests(teamId) {
  if (requestsUnsub) {
    requestsUnsub();
    requestsUnsub = null;
  }
  // teamId + status 두 등식 필터 → 지그재그 병합(복합 색인 불필요)
  const q = query(
    collection(db, JOIN_REQUESTS),
    where("teamId", "==", teamId),
    where("status", "==", "pending")
  );
  requestsUnsub = onSnapshot(
    q,
    (snap) => {
      requestsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderRequests();
    },
    (err) => {
      console.error("가입 신청 목록 구독 실패:", err);
      showError("가입 신청 목록을 불러오지 못했습니다: " + describeError(err));
    }
  );
}

// ----- 승인/거절 (위임) -----
reqListEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const li = e.target.closest(".ta-req");
  if (!li) return;
  if (myRole !== "admin" || !currentTeamId) {
    showError("관리자만 신청을 처리할 수 있습니다.");
    return;
  }

  const reqId = li.dataset.id;
  const applicantUid = li.dataset.uid;
  const action = btn.dataset.action;
  const req = requestsCache.find((r) => r.id === reqId);
  const nm = req ? req.displayName || applicantUid : applicantUid;

  if (action === "approve") {
    if (!applicantUid) {
      showError("신청자 UID를 확인할 수 없습니다.");
      return;
    }
    try {
      // 팀원 추가 + 신청 제거를 원자적으로 처리(둘 다 관리자에게 허용됨)
      const member = { uid: applicantUid, teamId: currentTeamId, role: "member" };
      // 신청서(joinRequests)의 이름·이메일을 멤버십에 함께 옮겨 저장(목록 표시용)
      if (req && req.displayName) member.displayName = req.displayName;
      if (req && req.email) member.email = req.email;
      if (myTeamName) member.teamName = myTeamName; // 팀 이름을 알면 함께 저장(선택)
      const batch = writeBatch(db);
      batch.set(
        doc(db, MEMBERSHIPS, membershipId(applicantUid, currentTeamId)),
        member
      );
      batch.delete(doc(db, JOIN_REQUESTS, reqId));
      await batch.commit();
      showInfo(`'${nm}' 님을 팀원으로 승인했습니다.`);
    } catch (err) {
      console.error("승인 실패:", err);
      if (err && err.code === "permission-denied") {
        showError(
          "권한이 없습니다(Missing or insufficient permissions). 관리자 권한/보안 규칙(firestore.rules)을 확인하세요."
        );
      } else {
        showError("승인에 실패했습니다: " + describeError(err));
      }
    }
  } else if (action === "reject") {
    if (!confirm(`'${nm}' 님의 가입 신청을 거절(삭제)할까요?`)) return;
    try {
      await deleteDoc(doc(db, JOIN_REQUESTS, reqId));
      showInfo(`'${nm}' 님의 신청을 거절했습니다.`);
    } catch (err) {
      console.error("거절 실패:", err);
      if (err && err.code === "permission-denied") {
        showError(
          "권한이 없습니다(Missing or insufficient permissions). 관리자 권한/보안 규칙(firestore.rules)을 확인하세요."
        );
      } else {
        showError("거절에 실패했습니다: " + describeError(err));
      }
    }
  }
});

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
  if (requestsUnsub) {
    requestsUnsub();
    requestsUnsub = null;
  }
  myRole = null;
  myTeamName = "";
  membersCache = [];
  requestsCache = [];
  clearMessage();

  if (!currentUid || !currentTeamId) {
    hidePanel();
    renderMembers();
    renderRequests();
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
        subscribeRequests(currentTeamId);
      } else {
        hidePanel();
        if (membersUnsub) {
          membersUnsub();
          membersUnsub = null;
        }
        if (requestsUnsub) {
          requestsUnsub();
          requestsUnsub = null;
        }
        membersCache = [];
        requestsCache = [];
        renderMembers();
        renderRequests();
      }
    },
    (err) => {
      // 팀 삭제 진행 중에는 슈퍼관리자 본인의 이 팀 멤버십이 지워지면서, 그 멤버십 문서를
      // 다시 읽으려다 permission-denied 가 날 수 있다(존재하지 않는 본인 문서 읽기).
      // 이는 정상적인 삭제의 부수효과이므로 치명 오류로 처리하지 않고 조용히 관리 영역만 숨긴다.
      // (관리 권한 판단은 멤버십이 아니라 슈퍼관리자 UID/실제 admin 멤버십으로 이뤄진다.)
      if (currentUid === SUPER_ADMIN_UID && err && err.code === "permission-denied") {
        myRole = null;
        hidePanel();
        membersCache = [];
        requestsCache = [];
        renderMembers();
        renderRequests();
        return;
      }
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

// ----- "가입 신청 현황" 아코디언 — 팀 관리와 동일 방식(별도 localStorage 키) -----
const REQ_OPEN_KEY = "teamRequestsOpen";
function loadReqOpen() {
  try {
    return localStorage.getItem(REQ_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
function saveReqOpen(open) {
  try {
    localStorage.setItem(REQ_OPEN_KEY, open ? "1" : "0");
  } catch {}
}
function applyReqOpenState(open) {
  reqPanel.classList.toggle("is-open", open);
  reqToggleEl.setAttribute("aria-expanded", String(open));
}
function setReqOpen(open) {
  applyReqOpenState(open);
  saveReqOpen(open);
}
reqToggleEl.addEventListener("click", () => {
  setReqOpen(!reqPanel.classList.contains("is-open"));
});
reqToggleEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  setReqOpen(!reqPanel.classList.contains("is-open"));
});
applyReqOpenState(loadReqOpen());

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
