// 9단계: 팀 가입 신청 (사용자 측) — 사용자가 팀을 골라 직접 가입을 신청한다.
//
// 표시 방식: 카드 나열 → "한 줄 압축(라벨 + 드롭다운 + 신청 버튼)" 으로 변경.
//  - 드롭다운: 아직 속하지 않았고, 아직 pending 신청도 없는 팀만(이름 + ID).
//  - "신청" → 기존 신청 폼(사유 + 개인정보 동의)을 연다. 동의·사유·기록 로직은 그대로.
//  - 신청하면 그 팀은 드롭다운에서 빠지고, 대기 중 신청은 작게 한 줄 + [철회] 로 표시.
//  - 신청 가능한 팀이 없으면 한 줄 안내.
//
// ★ 신청 데이터/동의 절차(필수 체크 + consentAt 기록)는 변경하지 않는다.
// 다른 팀/개인 모듈과 충돌하지 않도록 고유 클래스(team-join-*)만 사용한다.

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
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { describeError } from "./cloudErrors.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const TEAMS = "teams";
const MEMBERSHIPS = "memberships";
const JOIN_REQUESTS = "joinRequests";

// 신청 문서 id 규칙: "{uid}_{teamId}" (멤버십과 동일 규칙)
const requestId = (uid, teamId) => `${uid}_${teamId}`;

// ----- DOM 참조 (.team-screen 루트로 한정) -----
const root = document.querySelector(".team-screen");
const panelEl = root.querySelector(".team-join");
const selectEl = root.querySelector(".team-join-select");
const applyBtn = root.querySelector(".team-join-apply");
const errorEl = root.querySelector(".team-join-error");
const pendingEl = root.querySelector(".team-join-pending");
const formAreaEl = root.querySelector(".team-join-form-area");

// ----- 상태 -----
let currentUid = null;
let currentDisplayName = "";
let currentEmail = "";
let teamsCache = []; // [{ teamId, name }]
let myTeamIds = new Set(); // 내가 이미 속한 팀
let myRequests = {}; // { [teamId]: { status, ... } }
let teamsUnsub = null;
let membershipsUnsub = null;
let requestsUnsub = null;
let selectedJoinTeamId = null; // 신청 드롭다운 선택값
let selectedPendingTeamId = null; // 대기 중(철회) 드롭다운 선택값
let openFormTeamId = null; // 신청 폼이 열린 팀
let draftMessage = ""; // 폼 재렌더에도 입력 유지
let draftConsent = false; // 폼 재렌더에도 동의 상태 유지

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

// 가입 신청 가능한 팀: 미소속 && pending 신청 없음, 이름순
function joinableTeams() {
  return teamsCache
    .filter((t) => !myTeamIds.has(t.teamId))
    .filter(
      (t) => !(myRequests[t.teamId] && myRequests[t.teamId].status === "pending")
    )
    .sort((a, b) =>
      (a.name || a.teamId).localeCompare(b.name || b.teamId, "ko")
    );
}

// 내가 대기 중(pending)인 신청(아직 멤버 아님)
function pendingRequests() {
  return Object.values(myRequests)
    .filter((r) => r.status === "pending" && !myTeamIds.has(r.teamId))
    .sort((a, b) => (a.teamId || "").localeCompare(b.teamId || "", "ko"));
}

// ----- 드롭다운 + 신청 버튼 -----
function renderSelect() {
  const joinable = joinableTeams();

  // 선택값 유지(없어졌으면 첫 항목으로)
  if (
    selectedJoinTeamId &&
    !joinable.some((t) => t.teamId === selectedJoinTeamId)
  ) {
    selectedJoinTeamId = null;
  }
  if (!selectedJoinTeamId && joinable.length) {
    selectedJoinTeamId = joinable[0].teamId;
  }

  selectEl.innerHTML = "";
  if (joinable.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "가입 신청할 수 있는 팀이 없습니다";
    selectEl.append(opt);
    selectEl.disabled = true;
  } else {
    // 폼이 열려 있으면 잠가서 다른 팀으로 바뀌지 않게
    selectEl.disabled = openFormTeamId !== null;
    joinable.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.teamId;
      opt.textContent = `${t.name || t.teamId} (${t.teamId})`;
      if (t.teamId === selectedJoinTeamId) opt.selected = true;
      selectEl.append(opt);
    });
  }

  // 신청 버튼: 가입 가능한 팀이 있고 폼이 닫혀 있을 때만 활성
  applyBtn.disabled = joinable.length === 0 || openFormTeamId !== null;
}

// ----- 대기 중 신청(드롭다운 한 줄 + 철회) -----
function renderPending() {
  pendingEl.innerHTML = "";
  const pend = pendingRequests();
  if (pend.length === 0) {
    selectedPendingTeamId = null;
    return; // 비면 :empty 로 숨김
  }

  // 선택값 유지(없어졌으면 첫 항목)
  if (
    selectedPendingTeamId &&
    !pend.some((r) => r.teamId === selectedPendingTeamId)
  ) {
    selectedPendingTeamId = null;
  }
  if (!selectedPendingTeamId) selectedPendingTeamId = pend[0].teamId;

  const label = document.createElement("span");
  label.className = "team-join-pending-label";
  label.textContent = "대기 중";

  const sel = document.createElement("select");
  sel.className = "input team-join-pending-select";
  sel.setAttribute("aria-label", "대기 중인 신청 팀 선택");
  pend.forEach((r) => {
    const team = teamsCache.find((t) => t.teamId === r.teamId);
    const nm = team ? team.name || team.teamId : r.teamId;
    const opt = document.createElement("option");
    opt.value = r.teamId;
    opt.textContent = `${nm} (${r.teamId})`;
    if (r.teamId === selectedPendingTeamId) opt.selected = true;
    sel.append(opt);
  });

  const withdrawBtn = document.createElement("button");
  withdrawBtn.type = "button";
  withdrawBtn.className = "btn btn-cancel team-join-pending-withdraw";
  withdrawBtn.textContent = "철회";

  pendingEl.append(label, sel, withdrawBtn);
}

// ----- 신청 폼 (이름·이메일 자동 표시 + 사유 + 개인정보 동의) -----
function buildJoinForm(teamName) {
  const form = document.createElement("form");
  form.className = "team-join-form";
  form.autocomplete = "off";

  // 어느 팀에 신청하는지 표시
  const title = document.createElement("div");
  title.className = "team-join-form-title";
  title.textContent = `가입 신청: ${teamName}`;

  // 신청자: 로그인 정보 자동 표시(다시 입력하지 않음)
  const applicant = document.createElement("div");
  applicant.className = "team-join-applicant";
  applicant.textContent = `신청자: ${currentDisplayName || "(이름 없음)"} · ${
    currentEmail || "(이메일 없음)"
  }`;

  // 신청 사유(선택)
  const msgLabel = document.createElement("label");
  msgLabel.className = "team-join-field-label";
  msgLabel.textContent = "신청 사유 (선택)";

  const msg = document.createElement("textarea");
  msg.className = "input team-join-message";
  msg.placeholder =
    "어떤 자격/소속으로 참여하시는지 적어주세요 (예: ○○대학 ○○연구실 / ○○회사 ○○팀)";
  msg.value = draftMessage;
  msg.setAttribute("aria-label", "신청 사유");
  msgLabel.append(msg);

  // 개인정보 수집·이용 동의(필수) — 절차/문구 변경하지 않음
  const consent = document.createElement("div");
  consent.className = "team-join-consent";

  const ctitle = document.createElement("div");
  ctitle.className = "team-join-consent-title";
  ctitle.textContent = "개인정보 수집·이용 동의";

  const cul = document.createElement("ul");
  cul.className = "team-join-consent-list";
  [
    "수집 항목: 이름, 이메일",
    "이용 목적: 팀 가입 심사를 위한 신청자 식별",
    "보유·이용 기간: 본 서비스 이용 기간 동안 (탈퇴/신청 철회 시 파기)",
    "귀하는 동의를 거부할 권리가 있으며, 거부 시 팀 가입 신청이 제한됩니다.",
  ].forEach((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    cul.append(li);
  });

  const clabel = document.createElement("label");
  clabel.className = "team-join-consent-check";
  const cbox = document.createElement("input");
  cbox.type = "checkbox";
  cbox.className = "team-join-consent-input";
  cbox.checked = draftConsent;
  const ctext = document.createElement("span");
  ctext.textContent = "위 개인정보 수집·이용에 동의합니다.";
  clabel.append(cbox, ctext);

  consent.append(ctitle, cul, clabel);

  // 동작 버튼: 신청(동의해야 활성화) / 취소
  const actions = document.createElement("div");
  actions.className = "team-join-actions";

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "btn btn-add team-join-submit";
  submitBtn.textContent = "가입 신청";
  submitBtn.disabled = !draftConsent;

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-cancel team-join-cancel";
  cancelBtn.textContent = "취소";

  actions.append(submitBtn, cancelBtn);

  form.append(title, applicant, msgLabel, consent, actions);
  return form;
}

// ----- 신청 폼 영역 -----
function renderForm() {
  formAreaEl.innerHTML = "";
  if (!openFormTeamId) return;
  const team = teamsCache.find((t) => t.teamId === openFormTeamId);
  const nm = team ? team.name || team.teamId : openFormTeamId;
  formAreaEl.append(buildJoinForm(nm));
}

// ----- 전체 렌더 -----
function render() {
  if (!currentUid) {
    selectEl.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "로그인이 필요합니다";
    selectEl.append(opt);
    selectEl.disabled = true;
    applyBtn.disabled = true;
    pendingEl.innerHTML = "";
    formAreaEl.innerHTML = "";
    return;
  }
  renderSelect();
  renderPending();
  renderForm();
}

// ----- 드롭다운 선택 변경(위임: 신청/대기 두 드롭다운 모두) -----
panelEl.addEventListener("change", (e) => {
  if (e.target.classList.contains("team-join-select")) {
    selectedJoinTeamId = e.target.value || null;
  } else if (e.target.classList.contains("team-join-pending-select")) {
    selectedPendingTeamId = e.target.value || null;
  }
});

// ----- 클릭(위임): 신청 열기 / 취소 / 철회 -----
panelEl.addEventListener("click", async (e) => {
  // 신청 버튼 → 폼 열기
  if (e.target.closest(".team-join-apply")) {
    if (!selectedJoinTeamId) {
      showError("가입 신청할 팀을 선택하세요.");
      return;
    }
    openFormTeamId = selectedJoinTeamId;
    draftMessage = "";
    draftConsent = false;
    clearMessage();
    render();
    return;
  }

  // 취소 → 폼 닫기
  if (e.target.closest(".team-join-cancel")) {
    openFormTeamId = null;
    draftMessage = "";
    draftConsent = false;
    clearMessage();
    render();
    return;
  }

  // 철회 → 대기 드롭다운에서 고른 팀의 joinRequests 문서 삭제
  const wbtn = e.target.closest(".team-join-pending-withdraw");
  if (wbtn) {
    const teamId = selectedPendingTeamId;
    if (!teamId) return;
    const team = teamsCache.find((t) => t.teamId === teamId);
    const nm = team ? team.name || team.teamId : teamId;
    if (!confirm(`'${nm}' 팀 가입 신청을 철회할까요?`)) return;
    try {
      await deleteDoc(doc(db, JOIN_REQUESTS, requestId(currentUid, teamId)));
      showInfo("가입 신청을 철회했습니다.");
    } catch (err) {
      console.error("가입 신청 철회 실패:", err);
      if (err && err.code === "permission-denied") {
        showError(
          "권한이 없습니다(Missing or insufficient permissions). 보안 규칙(firestore.rules)이 게시되었는지 확인하세요."
        );
      } else {
        showError("철회에 실패했습니다: " + describeError(err));
      }
    }
    return;
  }
});

// ----- 폼 입력(위임): 사유 입력 / 동의 체크 → 신청 버튼 활성화 -----
panelEl.addEventListener("input", (e) => {
  if (e.target.classList.contains("team-join-message")) {
    draftMessage = e.target.value;
  } else if (e.target.classList.contains("team-join-consent-input")) {
    draftConsent = e.target.checked;
    const submitBtn = formAreaEl.querySelector(".team-join-submit");
    if (submitBtn) submitBtn.disabled = !draftConsent;
  }
});

// ----- 신청 제출(위임) — 동의·사유·기록 로직은 기존 그대로 -----
panelEl.addEventListener("submit", async (e) => {
  const form = e.target.closest(".team-join-form");
  if (!form) return;
  e.preventDefault();
  const teamId = openFormTeamId;
  if (!teamId) return;

  if (!currentUid) {
    showError("로그인 후 신청할 수 있습니다.");
    return;
  }
  // 동의 안 하면 신청 불가
  if (!draftConsent) {
    showError("개인정보 수집·이용에 동의해야 신청할 수 있습니다.");
    return;
  }
  // 이미 같은 팀에 pending 신청이 있으면 중복 방지
  if (myRequests[teamId] && myRequests[teamId].status === "pending") {
    showError("이미 이 팀에 가입을 신청했습니다. (대기 중)");
    return;
  }

  const message = draftMessage.trim();
  try {
    await setDoc(doc(db, JOIN_REQUESTS, requestId(currentUid, teamId)), {
      uid: currentUid,
      teamId,
      displayName: currentDisplayName,
      email: currentEmail,
      message,
      status: "pending",
      consentAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    });
    openFormTeamId = null;
    draftMessage = "";
    draftConsent = false;
    selectedJoinTeamId = null; // 신청한 팀은 드롭다운에서 빠지므로 선택 초기화
    showInfo("신청이 접수되었습니다. 관리자 승인을 기다려 주세요.");
    render(); // 스냅샷 타이밍과 무관하게 폼을 확실히 닫음
  } catch (err) {
    console.error("가입 신청 실패:", err);
    if (err && err.code === "permission-denied") {
      showError(
        "권한이 없습니다(Missing or insufficient permissions). 보안 규칙(firestore.rules)이 게시되었는지 확인하세요."
      );
    } else {
      showError("가입 신청에 실패했습니다: " + describeError(err));
    }
  }
});

// ----- 구독: 전체 팀 목록 -----
function subscribeTeams() {
  if (teamsUnsub) {
    teamsUnsub();
    teamsUnsub = null;
  }
  teamsUnsub = onSnapshot(
    collection(db, TEAMS),
    (snap) => {
      teamsCache = snap.docs.map((d) => ({
        teamId: d.id,
        name: d.data().name || "",
      }));
      render();
    },
    (err) => {
      console.error("팀 목록 구독 실패:", err);
      showError("팀 목록을 불러오지 못했습니다: " + describeError(err));
    }
  );
}

// ----- 구독: 내 소속(이미 속한 팀 제외용) -----
function subscribeMemberships(uid) {
  if (membershipsUnsub) {
    membershipsUnsub();
    membershipsUnsub = null;
  }
  const q = query(collection(db, MEMBERSHIPS), where("uid", "==", uid));
  membershipsUnsub = onSnapshot(
    q,
    (snap) => {
      const set = new Set();
      snap.forEach((d) => {
        const t = d.data().teamId;
        if (t) set.add(t);
      });
      myTeamIds = set;
      render();
    },
    (err) => {
      console.error("소속 구독 실패:", err);
    }
  );
}

// ----- 구독: 내 가입 신청(상태 표시·중복 방지용) -----
function subscribeRequests(uid) {
  if (requestsUnsub) {
    requestsUnsub();
    requestsUnsub = null;
  }
  const q = query(collection(db, JOIN_REQUESTS), where("uid", "==", uid));
  requestsUnsub = onSnapshot(
    q,
    (snap) => {
      const map = {};
      snap.forEach((d) => {
        const data = d.data();
        if (data.teamId) map[data.teamId] = data;
      });
      myRequests = map;
      render();
    },
    (err) => {
      console.error("가입 신청 구독 실패:", err);
      showError("신청 내역을 불러오지 못했습니다: " + describeError(err));
    }
  );
}

// ----- 인증 상태 -----
onAuthStateChanged(auth, (user) => {
  if (teamsUnsub) {
    teamsUnsub();
    teamsUnsub = null;
  }
  if (membershipsUnsub) {
    membershipsUnsub();
    membershipsUnsub = null;
  }
  if (requestsUnsub) {
    requestsUnsub();
    requestsUnsub = null;
  }
  teamsCache = [];
  myTeamIds = new Set();
  myRequests = {};
  selectedJoinTeamId = null;
  selectedPendingTeamId = null;
  openFormTeamId = null;
  draftMessage = "";
  draftConsent = false;
  clearMessage();

  if (user) {
    currentUid = user.uid;
    currentDisplayName = user.displayName || "";
    currentEmail = user.email || "";
    subscribeTeams();
    subscribeMemberships(currentUid);
    subscribeRequests(currentUid);
  } else {
    currentUid = null;
    currentDisplayName = "";
    currentEmail = "";
  }
  render();
});

// 첫 렌더(로그인 전)
render();
