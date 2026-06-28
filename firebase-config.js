// Firebase 설정값 — 여기에 본인의 firebaseConfig를 채워 넣으세요.
//
// 받는 곳: Firebase 콘솔(https://console.firebase.google.com)
//   → 프로젝트 선택 → ⚙ 프로젝트 설정 → "내 앱"에서 웹 앱(</>) 등록 후
//     표시되는 firebaseConfig 객체의 값을 그대로 복사해 아래에 붙여 넣습니다.
//
// 또한 콘솔에서 다음을 켜 두어야 로그인이 동작합니다.
//   - Authentication → 로그인 방법 → Google 사용 설정
//   - Authentication → 설정 → 승인된 도메인에 앱을 여는 도메인 추가
//     (로컬 테스트는 localhost / 127.0.0.1 가 기본 포함됨)
//   - Firestore Database 생성 (users 컬렉션 저장에 사용)

export const firebaseConfig = {
  apiKey: "AIzaSyDzguthIuTGAbAGNuRFenntcqUtZQwzDN4",
  authDomain: "daylist-team.firebaseapp.com",
  projectId: "daylist-team",
  storageBucket: "daylist-team.firebasestorage.app",
  messagingSenderId: "602215323091",
  appId: "1:602215323091:web:bccb6db8c824b0721fcb26",
};
