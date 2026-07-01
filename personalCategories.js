// 관리 탭 왼쪽 "프로젝트 관리" — 개인용 카테고리 추가(본인 전용, 모든 로그인 사용자).
//
// 이 모듈이 담당하는 것:
//  1) 본인 users/{uid}.extraCategories 배열에 { id, name, color } append(사용자당 최대 3개).
//     - id 는 내부 식별자(extra1/extra2/…), name 은 표시 이름, color 는 기본(일상)·서로와 겹치지 않게 자동 배정.
//     - 저장은 users/{uid} 문서 write(보안 규칙상 본인 users 는 본인이 read/write 가능 — 규칙 변경 불필요).
//       다른 필드(displayName/email)를 보존하려고 merge write 를 쓴다(사실상 update, 문서가 없으면 생성).
//  2) 현재 본인 추가 카테고리 목록 표시(이번 단계에선 삭제·이름변경 없음, 표시만).
//
// 팀 카테고리(teamCategories.js)의 개인용 판. DOM 조회는 .manage-projects-col 루트로 한정하고
// JS 후크는 .pcatm-* 로, 스타일은 팀과 공유하는 .mcat-* 로 구분한다.

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
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { describeError } from "./cloudErrors.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const USERS = "users";
const MAX_EXTRA = 3; // 기본 1개(일상) 외 추가 최대 3개

// 기본 개인 카테고리 색(styles.css 의 '일상' 배지색 #2bb8c4) — 추가 색이 이것과 겹치지 않게 한다.
const BASE_COLORS = ["#2bb8c4"];
// 추가 카테고리 자동 배정 팔레트(기본 teal 과도, 서로도 겹치지 않게 순서대로 미사용 색을 고른다).
const EXTRA_PALETTE = ["#8b5cf6", "#f0883b", "#e0457b", "#20a779", "#eab308", "#6366f1"];

// ----- DOM 참조 (.manage-projects-col 루트) -----
const root = document.querySelector(".manage-projects-col");
const sectionEl = root.querySelector(".pcatm");
const formEl = root.querySelector(".pcatm-form");
const nameInput = root.querySelector(".pcatm-name-input");
const addBtn = root.querySelector(".pcatm-add-btn");
const hintEl = root.querySelector(".pcatm-hint");
const msgEl = root.querySelector(".pcatm-msg");
const listEl = root.querySelector(".pcatm-list");

// ----- 상태 -----
let currentUid = null;
let extraCategories = []; // 본인 추가 카테고리 [{id,name,color}]
let userDocUnsub = null;

// ----- 메시지 -----
function showMsg(text, isError) {
  msgEl.textContent = text;
  msgEl.classList.toggle("is-error", !!isError);
}
function clearMsg() {
  msgEl.textContent = "";
  msgEl.classList.remove("is-error");
}

// ----- 표시/숨김: 로그인한 사용자에게만(본인 전용) -----
function updateVisibility() {
  sectionEl.classList.toggle("is-hidden", !currentUid);
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
  const remaining = MAX_EXTRA - extraCategories.length;
  const full = remaining <= 0;
  nameInput.disabled = full;
  addBtn.disabled = full;
  hintEl.textContent = full
    ? "추가 카테고리가 최대치(3개)에 도달했습니다. 더 추가할 수 없습니다."
    : `기본 카테고리(일상) 외에 최대 ${MAX_EXTRA}개까지 추가할 수 있습니다. (남은 ${remaining}개)`;
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
  if (!currentUid) return;
  if (extraCategories.length >= MAX_EXTRA) {
    showMsg("추가 카테고리는 최대 3개까지입니다.", true);
    return;
  }
  const name = nameInput.value.trim();
  if (!name) {
    showMsg("카테고리 이름을 입력하세요.", true);
    return;
  }
  const lower = name.toLowerCase();
  if (name === "일상") {
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
    // users/{uid} 에 extraCategories 만 merge 로 기록(displayName/email 등 다른 필드 보존).
    await setDoc(
      doc(db, USERS, currentUid),
      { extraCategories: updated },
      { merge: true }
    );
    formEl.reset();
    nameInput.focus();
    showMsg(`'${name}' 카테고리를 추가했습니다.`, false);
    // 목록은 users 스냅샷이 도착하면 자동 갱신된다.
  } catch (err) {
    console.error("개인 카테고리 추가 실패:", err);
    if (err && err.code === "permission-denied") {
      showMsg("권한이 없습니다. firestore.rules 가 게시되었는지 확인하세요.", true);
    } else {
      showMsg("카테고리 추가에 실패했습니다: " + describeError(err), true);
    }
  }
});

// ----- 본인 users 문서 구독(추가 카테고리 목록) -----
function subscribeUserDoc(uid) {
  if (userDocUnsub) {
    userDocUnsub();
    userDocUnsub = null;
  }
  extraCategories = [];
  if (!uid) {
    renderList();
    return;
  }
  userDocUnsub = onSnapshot(
    doc(db, USERS, uid),
    (snap) => {
      const data = snap.exists() ? snap.data() : {};
      extraCategories = Array.isArray(data.extraCategories)
        ? data.extraCategories
        : [];
      renderList();
    },
    (err) => {
      console.error("users 문서 구독 실패:", err);
    }
  );
}

// ----- 인증 상태 -----
onAuthStateChanged(auth, (user) => {
  currentUid = user ? user.uid : null;
  clearMsg();
  subscribeUserDoc(currentUid);
  updateVisibility();
});

// 첫 렌더(로그인 전): 숨김
updateVisibility();
renderList();
