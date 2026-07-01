// 10단계: '팀 관리' 탭 — 운영·관리 기능을 한 탭으로 모은다.
//
// 이 모듈이 담당하는 것:
//  1) 상단 '팀 관리' 탭의 표시/숨김
//     - 슈퍼관리자(특정 UID) 또는 어느 팀이든 admin 인 사용자에게만 보인다.
//  2) '관리할 팀' 선택 드롭다운
//     - 슈퍼관리자: 모든 팀 / 팀관리자: 자기가 admin 인 팀만.
//     - 선택을 "team-manage-team-selected" 이벤트로 teamAdmin.js 에 알린다(팀원 관리·가입 신청 처리).
//  3) 새 팀 만들기(슈퍼관리자 전용) — teamProjects.js 에서 이 탭으로 이동.
//
// 권한·데이터·보안 규칙 로직은 그대로다. 위치(어느 탭/화면)만 바뀌었다.
// DOM 조회는 .team-manage-screen 루트로 한정한다(teamAdmin.js 와 동일 루트).

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
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { describeError } from "./cloudErrors.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const TEAMS = "teams";
const MEMBERSHIPS = "memberships";
const TEAM_TASKS = "teamTasks";
const TEAM_PROJECTS = "teamProjects";
const JOIN_REQUESTS = "joinRequests";
const MANAGE_EVENT = "team-manage-team-selected"; // teamAdmin.js 로 (teamId) 통지
const SUPER_ADMIN_UID = "NiNrcxpjoOTfr9dPLvq9jz3L8eK2";
const DELETE_BATCH_LIMIT = 450; // writeBatch 한도(500) 안전 마진

// ----- DOM 참조 -----
const root = document.querySelector(".team-manage-screen");
const manageTabBtn = document.querySelector(".team-manage-tab");
// 오른쪽 '팀 관리' 열 — 슈퍼관리자/팀관리자에게만 표시. 왼쪽 '프로젝트 관리'는 항상 표시.
const teamCol = root.querySelector(".manage-team-col");
const selectEl = root.querySelector(".admin-team-select");
const createTeamForm = root.querySelector(".create-team-form");
const createTeamIdInput = root.querySelector(".create-team-id");
const createTeamNameInput = root.querySelector(".create-team-name");
const createTeamMsg = root.querySelector(".create-team-msg");
// 팀명 변경 DOM
const renameBar = root.querySelector(".manage-rename-bar");
const renameForm = root.querySelector(".manage-rename-form");
const renameInput = root.querySelector(".manage-name-input");
const renameMsg = root.querySelector(".manage-rename-msg");
// 팀 삭제(위험 구역) DOM — 슈퍼관리자 전용
const dangerPanel = root.querySelector(".team-danger");
const deleteIdInput = root.querySelector(".delete-team-id-input");
const deleteBtn = root.querySelector(".team-delete-btn");
const dangerMsg = root.querySelector(".team-danger-msg");

// ----- 상태 -----
let currentUid = null;
let currentDisplayName = ""; // 부트스트랩 멤버십에 본인 이름 저장용
let currentEmail = ""; // 부트스트랩 멤버십에 본인 이메일 저장용
let isSuper = false;
let teamsCache = []; // [{ teamId, name }] (전체)
let myAdminTeamIds = new Set(); // 내가 admin 인 팀
let teamsUnsub = null;
let membershipsUnsub = null;
let selectedManageTeamId = null;
let lastEmitted = undefined; // 중복 emit 방지
let nameSyncedTeamId = undefined; // 이름 입력칸을 마지막으로 채운 팀(사용자 입력 보존용)
let dangerSyncedTeamId = undefined; // 위험 구역(삭제 확인 입력칸)을 마지막으로 초기화한 팀
let deleting = false; // 삭제 진행 중 플래그(중복 클릭 방지)

// ----- 선택 통지 -----
function emitIfChanged(teamId) {
  const id = teamId || null;
  if (id === lastEmitted) return;
  lastEmitted = id;
  document.dispatchEvent(
    new CustomEvent(MANAGE_EVENT, { detail: { teamId: id } })
  );
}

// ----- 관리 가능한 팀 목록 -----
function manageableTeams() {
  const list = isSuper
    ? teamsCache.slice()
    : teamsCache.filter((t) => myAdminTeamIds.has(t.teamId));
  return list.sort((a, b) =>
    (a.name || a.teamId).localeCompare(b.name || b.teamId, "ko")
  );
}

// ----- 탭 표시/숨김 -----
// '관리' 탭은 로그인한 모든 사용자에게 보인다(왼쪽 '프로젝트 관리'는 누구나 사용).
function updateTabVisibility(loggedIn) {
  if (!manageTabBtn) return;
  manageTabBtn.classList.toggle("is-hidden", !loggedIn);
}

// ----- 오른쪽 '팀 관리' 열 표시/숨김 -----
// 슈퍼관리자 또는 어느 팀이든 admin 인 사용자(팀 관리자)에게만 보인다.
// 일반 사용자는 왼쪽 '프로젝트 관리'만 보고, 오른쪽 열은 아예 표시되지 않는다.
function updateTeamColVisibility(authorized) {
  if (!teamCol) return;
  teamCol.classList.toggle("is-hidden", !authorized);
}

// ----- 새 팀 만들기 표시/숨김 (슈퍼관리자 전용) -----
function updateCreateTeamVisibility() {
  createTeamForm.classList.toggle("is-hidden", !isSuper);
  if (!isSuper) {
    createTeamForm.reset();
    createTeamMsg.textContent = "";
    createTeamMsg.classList.remove("is-error");
  }
}
function showCreateTeamMsg(msg, isError) {
  createTeamMsg.textContent = msg;
  createTeamMsg.classList.toggle("is-error", !!isError);
}

// ----- 관리할 팀 드롭다운 렌더 -----
function renderSelect() {
  const manageable = manageableTeams();

  // 선택값 유지(없어졌으면 첫 항목)
  if (
    selectedManageTeamId &&
    !manageable.some((t) => t.teamId === selectedManageTeamId)
  ) {
    selectedManageTeamId = null;
  }
  if (!selectedManageTeamId && manageable.length) {
    selectedManageTeamId = manageable[0].teamId;
  }

  selectEl.innerHTML = "";
  if (manageable.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "관리할 팀이 없습니다";
    selectEl.append(opt);
    selectEl.disabled = true;
  } else {
    selectEl.disabled = false;
    manageable.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.teamId;
      opt.textContent = `${t.name || t.teamId} (${t.teamId})`;
      if (t.teamId === selectedManageTeamId) opt.selected = true;
      selectEl.append(opt);
    });
  }

  // 선택된 팀을 teamAdmin.js 에 통지(변경 시에만)
  emitIfChanged(selectedManageTeamId);
  // 팀명 변경 UI 동기화
  syncNameInput();
  updateRenameBar();
  // 팀 삭제(위험 구역) 표시·동기화
  updateDangerZone();
}

// 이름 입력칸: 선택 팀이 "바뀐 경우에만" 현재 이름으로 채운다(사용자 입력 중 덮어쓰기 방지).
function syncNameInput() {
  if (selectedManageTeamId === nameSyncedTeamId) return;
  nameSyncedTeamId = selectedManageTeamId;
  const team = teamsCache.find((t) => t.teamId === selectedManageTeamId);
  renameInput.value = team ? team.name || "" : "";
  renameMsg.textContent = "";
  renameMsg.classList.remove("is-error");
}

// 팀명 변경 바: 선택된 팀이 있을 때만 표시
function updateRenameBar() {
  renameBar.classList.toggle("is-hidden", !selectedManageTeamId);
}

function showRenameMsg(msg, isError) {
  renameMsg.textContent = msg;
  renameMsg.classList.toggle("is-error", !!isError);
}

// ----- 전체 렌더 -----
function render() {
  const authorized = !!currentUid && (isSuper || myAdminTeamIds.size > 0);
  updateTabVisibility(!!currentUid); // 탭: 로그인 사용자 전원
  updateTeamColVisibility(authorized); // 오른쪽 팀 관리 열: 관리자만
  updateCreateTeamVisibility();
  renderSelect();
}

// ----- 드롭다운 선택 변경 -----
selectEl.addEventListener("change", () => {
  selectedManageTeamId = selectEl.value || null;
  emitIfChanged(selectedManageTeamId);
  syncNameInput();
  updateRenameBar();
});

// ----- 팀명 변경 (표시이름 name 만 수정 — teamId 는 불변) -----
renameForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const teamId = selectedManageTeamId;
  if (!teamId) {
    showRenameMsg("먼저 관리할 팀을 선택하세요.", true);
    return;
  }
  const name = renameInput.value.trim();
  if (!name) {
    showRenameMsg("팀 이름을 입력하세요.", true);
    return;
  }

  try {
    // teams/{teamId} 의 name 만 변경(문서 id=teamId 는 그대로).
    await updateDoc(doc(db, TEAMS, teamId), { name });
    showRenameMsg("팀 이름이 변경되었습니다.", false);
    // teams 스냅샷이 곧 도착해 드롭다운 표시를 갱신한다(입력칸은 이미 새 이름).
  } catch (err) {
    console.error("팀명 변경 실패:", err);
    if (err && err.code === "permission-denied") {
      showRenameMsg(
        "권한이 없습니다(Missing or insufficient permissions). 그 팀의 관리자/슈퍼관리자인지, firestore.rules 가 게시되었는지 확인하세요.",
        true
      );
    } else {
      showRenameMsg("팀명 변경에 실패했습니다: " + describeError(err), true);
    }
  }
});

// ===== 팀 삭제(위험 구역) — 슈퍼관리자 전용 =====

function showDangerMsg(msg, isError) {
  dangerMsg.textContent = msg;
  dangerMsg.classList.toggle("is-error", !!isError);
}

// 위험 구역 표시/숨김 + 선택 팀이 바뀌면 확인 입력칸·메시지 초기화.
// (슈퍼관리자이고 삭제할 팀이 선택돼 있을 때만 노출. 팀 관리자에겐 보이지 않음.)
function updateDangerZone() {
  if (!dangerPanel) return;
  const show = isSuper && !!selectedManageTeamId;
  dangerPanel.classList.toggle("is-hidden", !show);
  // 삭제 진행 중에는 입력칸을 비우지 않는다(진행 메시지·잠금 유지).
  if (!deleting && selectedManageTeamId !== dangerSyncedTeamId) {
    dangerSyncedTeamId = selectedManageTeamId;
    deleteIdInput.value = "";
    showDangerMsg("", false);
  }
}

// 한 컬렉션에서 teamId 가 일치하는 문서를 모두 조회해 ref 배열로 반환.
async function refsByTeam(collName, teamId) {
  const snap = await getDocs(
    query(collection(db, collName), where("teamId", "==", teamId))
  );
  return snap.docs.map((d) => d.ref);
}

// 문서 ref 배열을 배치 한도(500)에 맞춰 나눠 삭제. 삭제한 건수 반환.
async function deleteRefsInChunks(refs) {
  let deleted = 0;
  for (let i = 0; i < refs.length; i += DELETE_BATCH_LIMIT) {
    const chunk = refs.slice(i, i + DELETE_BATCH_LIMIT);
    const batch = writeBatch(db);
    chunk.forEach((ref) => batch.delete(ref));
    await batch.commit();
    deleted += chunk.length;
  }
  return deleted;
}

// 연쇄 삭제: 하위 데이터(할일→프로젝트→신청)부터 지우고, memberships 는 "마지막에서 두 번째",
// teams 문서를 맨 마지막에 지운다.
//   ★ memberships 를 일찍 지우면 슈퍼관리자 본인의 이 팀 admin 멤버십까지 사라져,
//     이후 단계의 보안 규칙이 (멤버십 기반) isTeamAdmin 로 폴백할 때 권한이 막힌다(자기 발판 제거).
//     그래서 멤버십에 의존하는 단계(할일/프로젝트/가입신청)를 모두 끝낸 뒤 memberships 를 지운다.
//     memberships 와 teams 의 삭제는 보안 규칙상 isSuperAdmin()(UID 기준)만으로 허용되므로
//     본인 멤버십이 사라진 뒤에도 문제없이 완료된다.
//   ★ 중간에 실패해 일부만 지워진 팀을, 같은 팀을 다시 삭제하면 남은 문서부터 정리한다
//     (각 단계가 teamId 로 다시 조회해 남아 있는 것만 지우므로 재실행이 곧 정리 작업).
// 각 단계 완료를 콘솔에 기록해, 중간 실패 시 어디까지 지워졌는지 알 수 있게 한다.
async function deleteTeamCascade(teamId) {
  const steps = [
    { name: TEAM_TASKS, label: "할일" },
    { name: TEAM_PROJECTS, label: "프로젝트" },
    { name: JOIN_REQUESTS, label: "가입 신청" },
    { name: MEMBERSHIPS, label: "멤버십" }, // 슈퍼관리자 본인 멤버십 포함 — 마지막에 제거
  ];
  for (const step of steps) {
    const refs = await refsByTeam(step.name, teamId);
    const n = await deleteRefsInChunks(refs);
    console.log(`[팀 삭제] ${step.name}(${step.label}) ${n}건 삭제 완료 (teamId=${teamId})`);
  }
  // 맨 마지막으로 팀 문서 자체(보안 규칙: isSuperAdmin() — 멤버십 불필요)
  await deleteDoc(doc(db, TEAMS, teamId));
  console.log(`[팀 삭제] teams/${teamId} 문서 삭제 완료 — 연쇄 삭제 종료`);
}

// 삭제 버튼: 2단계 확인(1차 경고 confirm + 2차 팀 ID 입력 일치) 후 실행.
deleteBtn.addEventListener("click", async () => {
  if (!isSuper) return; // 방어적: UI 가 숨겨져 있어도 한 번 더 확인
  if (deleting) return; // 중복 클릭 방지
  const teamId = selectedManageTeamId;
  if (!teamId) {
    showDangerMsg("먼저 삭제할 팀을 선택하세요.", true);
    return;
  }
  const team = teamsCache.find((t) => t.teamId === teamId);
  const teamName = team ? team.name || teamId : teamId;

  // 1차 확인: 경고 대화상자
  const ok = confirm(
    `정말 '${teamName}'을(를) 삭제하시겠습니까?\n\n` +
      "이 팀의 모든 프로젝트·할일·멤버·신청이 영구 삭제되며 되돌릴 수 없습니다."
  );
  if (!ok) return;

  // 2차 확인: 입력한 팀 ID 가 실제 팀 ID 와 정확히 일치해야 함(오삭제 방지)
  const typed = deleteIdInput.value.trim();
  if (typed !== teamId) {
    showDangerMsg(
      `팀 ID가 일치하지 않습니다. 삭제하려면 '${teamId}' 를 정확히 입력하세요.`,
      true
    );
    deleteIdInput.focus();
    return;
  }

  // 삭제 진행: 로딩 표시 + 잠금
  deleting = true;
  deleteBtn.disabled = true;
  deleteIdInput.disabled = true;
  showDangerMsg("팀을 삭제하는 중입니다… 잠시만 기다려 주세요.", false);

  try {
    await deleteTeamCascade(teamId);

    // 삭제 후: 선택을 다른 팀(또는 없음)으로 전환하고 화면 갱신.
    // teams 스냅샷도 곧 도착하지만, 즉시 반영하기 위해 캐시에서도 제거.
    teamsCache = teamsCache.filter((t) => t.teamId !== teamId);
    selectedManageTeamId = null;
    deleteIdInput.value = "";
    deleting = false;
    deleteBtn.disabled = false;
    deleteIdInput.disabled = false;
    render(); // renderSelect 가 다음 팀을 자동 선택(없으면 "관리할 팀이 없습니다")
    alert(`'${teamName}' 팀이 삭제되었습니다.`);
  } catch (err) {
    console.error("팀 삭제 실패:", err);
    deleting = false;
    deleteBtn.disabled = false;
    deleteIdInput.disabled = false;
    if (err && err.code === "permission-denied") {
      showDangerMsg(
        "권한이 없습니다. 슈퍼관리자 권한 또는 규칙(firestore.rules)을 확인하세요. " +
          "(일부 데이터만 삭제되었을 수 있습니다 — 콘솔 로그에서 진행 단계를 확인하세요.)",
        true
      );
    } else {
      showDangerMsg(
        "팀 삭제 중 오류가 발생했습니다(콘솔 로그에서 진행 단계 확인): " +
          describeError(err),
        true
      );
    }
  }
});

// ----- 새 팀 만들기 제출 (teamProjects.js 에서 이동, 로직 동일) -----
createTeamForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isSuper) return; // 방어적: UI 가 숨겨져 있어도 한 번 더 확인

  const teamId = createTeamIdInput.value.trim();
  const name = createTeamNameInput.value.trim();

  // 입력 검증: 팀 ID 는 영문 소문자/숫자만, 공백·빈값·특수문자 차단
  if (!teamId) {
    showCreateTeamMsg("팀 ID 를 입력하세요.", true);
    return;
  }
  if (!/^[a-z0-9]+$/.test(teamId)) {
    showCreateTeamMsg("팀 ID 는 영문 소문자와 숫자만 사용할 수 있습니다.", true);
    return;
  }
  if (!name) {
    showCreateTeamMsg("팀 이름을 입력하세요.", true);
    return;
  }

  try {
    // 이미 존재하는 팀 ID 면 덮어쓰기 방지
    const existing = await getDoc(doc(db, TEAMS, teamId));
    if (existing.exists()) {
      showCreateTeamMsg(`이미 '${teamId}' 팀이 존재합니다. 다른 ID 를 사용하세요.`, true);
      return;
    }

    // 두 문서를 함께 기록: teams/{팀ID} + memberships/{내UID}_{팀ID}(role:admin)
    await setDoc(doc(db, TEAMS, teamId), {
      name,
      createdBy: currentUid,
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, MEMBERSHIPS, `${currentUid}_${teamId}`), {
      uid: currentUid,
      teamId,
      role: "admin",
      teamName: name,
      displayName: currentDisplayName, // 팀원 목록에 "이름 (이메일)" 로 표시되도록 본인 정보 저장
      email: currentEmail,
    });

    createTeamForm.reset();
    showCreateTeamMsg(`'${name}' 팀을 만들었습니다.`, false);

    // 새 팀을 바로 '관리할 팀'으로 선택(스냅샷이 도착하면 드롭다운에 추가되고 선택 유지)
    selectedManageTeamId = teamId;
  } catch (err) {
    console.error("팀 생성 실패:", err);
    if (err && err.code === "permission-denied") {
      showCreateTeamMsg(
        "권한이 없습니다(Missing or insufficient permissions). 슈퍼관리자 계정인지, firestore.rules 가 게시되었는지 확인하세요.",
        true
      );
    } else {
      showCreateTeamMsg("팀 생성에 실패했습니다: " + describeError(err), true);
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
    }
  );
}

// ----- 구독: 내 소속(어느 팀의 admin 인지) -----
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
        const data = d.data();
        if (data.teamId && data.role === "admin") set.add(data.teamId);
      });
      myAdminTeamIds = set;
      render();
    },
    (err) => {
      console.error("소속 구독 실패:", err);
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
  teamsCache = [];
  myAdminTeamIds = new Set();
  selectedManageTeamId = null;
  lastEmitted = undefined;
  nameSyncedTeamId = undefined;
  dangerSyncedTeamId = undefined;

  if (user) {
    currentUid = user.uid;
    currentDisplayName = user.displayName || "";
    currentEmail = user.email || "";
    isSuper = currentUid === SUPER_ADMIN_UID;
    subscribeTeams();
    subscribeMemberships(currentUid);
  } else {
    currentUid = null;
    currentDisplayName = "";
    currentEmail = "";
    isSuper = false;
  }
  render();
});

// 첫 렌더(로그인 전): 탭 숨김
render();
