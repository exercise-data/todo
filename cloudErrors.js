// 공통 오류 메시지 변환 — Firestore 오류를 사용자에게 명확한 한국어 안내로 바꾼다.
// 특히 권한 오류(permission-denied / "Missing or insufficient permissions")를 또렷하게 알린다.

export function describeError(err) {
  const code = err && err.code;
  const msg = (err && err.message) || String(err);

  if (
    code === "permission-denied" ||
    /Missing or insufficient permissions/i.test(msg)
  ) {
    return "권한이 없습니다. 로그인 상태·팀 소속·관리자 권한을 확인하고, Firestore 보안 규칙이 게시되었는지 확인하세요.";
  }
  if (code === "unavailable" || code === "network-request-failed") {
    return "네트워크에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.";
  }
  if (code === "failed-precondition") {
    return "쿼리에 필요한 색인이 없을 수 있습니다. 브라우저 콘솔의 오류 링크로 색인을 생성하세요.";
  }
  if (code === "unauthenticated") {
    return "로그인이 필요합니다. 다시 로그인해 주세요.";
  }
  return msg;
}
