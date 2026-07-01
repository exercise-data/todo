// 1단계: Firebase 연결과 Google 로그인.
//
// 이 파일은 ES 모듈(<script type="module">)로 로드됩니다.
// Firebase v9+ 모듈 SDK를 gstatic CDN에서 가져와 Google 로그인을 붙입니다.
// firebaseConfig 값은 firebase-config.js 에서 채웁니다(값 분리).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// Firebase 초기화
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
// 세션이 있어도 항상 계정 선택 화면을 띄운다(계정 변경/로그인 공통) — 다른 구글 계정 전환 용이.
provider.setCustomParameters({ prompt: "select_account" });

// DOM 참조
const body = document.body;
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const copyBtn = document.getElementById("copy-uid-btn");
const switchBtn = document.getElementById("switch-account-btn");
const nameEl = document.getElementById("auth-name");
const uidEl = document.getElementById("auth-uid");
const errEl = document.getElementById("auth-error");

// Google로 로그인
loginBtn.addEventListener("click", async () => {
  errEl.textContent = "";
  try {
    await signInWithPopup(auth, provider);
    // 이후 처리는 onAuthStateChanged 에서 일괄 수행
  } catch (err) {
    console.error("로그인 실패:", err);
    errEl.textContent = "로그인에 실패했습니다: " + (err?.message || err);
  }
});

// 로그아웃 → 로그인 화면으로 복귀(상태 전환은 onAuthStateChanged 가 담당)
logoutBtn.addEventListener("click", async () => {
  try {
    await signOut(auth);
  } catch (err) {
    console.error("로그아웃 실패:", err);
  }
});

// 계정 변경 → 현재 계정을 로그아웃한 뒤 계정 선택 창을 띄워 다른 구글 계정으로 로그인.
// provider 에 prompt:'select_account' 가 적용돼 있어 세션이 있어도 선택 화면이 뜬다.
// 로그인 성공 후의 화면·데이터 갱신은 onAuthStateChanged(및 각 모듈의 구독)이 담당한다.
switchBtn.addEventListener("click", async () => {
  errEl.textContent = "";
  try {
    await signOut(auth);
    await signInWithPopup(auth, provider);
  } catch (err) {
    console.error("계정 변경 실패:", err);
    errEl.textContent = "계정 변경에 실패했습니다: " + (err?.message || err);
  }
});

// UID 복사(관리자 등록에 사용)
copyBtn.addEventListener("click", async () => {
  const uid = uidEl.textContent.trim();
  if (!uid) return;
  const original = copyBtn.textContent; // 아이콘(📋) 유지 — 복사 후 원래 아이콘으로 복원
  try {
    await navigator.clipboard.writeText(uid);
    // 팀원 관리의 "UID 복사"와 동일한 피드백: "복사됨" 문구를 잠깐 표시
    copyBtn.textContent = "복사됨";
    setTimeout(() => {
      copyBtn.textContent = original;
    }, 1200);
  } catch (err) {
    console.error("UID 복사 실패:", err);
    // 클립보드 API가 막힌 환경(예: file://)을 위한 대비: 텍스트 선택
    const range = document.createRange();
    range.selectNodeContents(uidEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
});

// 로그인 상태 감지
onAuthStateChanged(auth, async (user) => {
  if (user) {
    // 로그인됨: 이름과 UID 표시, 앱 본체로 전환
    nameEl.textContent = user.displayName || "(이름 없음)";
    uidEl.textContent = user.uid;
    body.setAttribute("data-auth", "in");

    // users/{uid} 문서에 본인 정보만 저장(merge로 기존 필드 보존)
    try {
      await setDoc(
        doc(db, "users", user.uid),
        {
          displayName: user.displayName || "",
          email: user.email || "",
        },
        { merge: true }
      );
    } catch (err) {
      console.error("사용자 정보 저장 실패:", err);
    }
  } else {
    // 로그아웃됨: 표시 초기화, 로그인 화면으로 복귀
    nameEl.textContent = "";
    uidEl.textContent = "";
    body.setAttribute("data-auth", "out");
  }
});
