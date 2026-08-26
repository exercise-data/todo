# CLAUDE.md

이 저장소에서 작업할 때 지켜야 할 관례. 진행 로그·배경은 REBUILD_PLAN.md 참고.

## UI 규칙 — 날짜 입력 옆 버튼 정렬
- 날짜 입력은 '라벨 + 입력칸' 세로 2단. 옆 버튼(추가/저장/취소/적용/닫기)은:
  - 정렬: '라벨 제외 입력 박스' 기준 세로 중앙. `align-items: center` 금지
    (라벨 때문에 버튼이 위로 뜸 — 반복 재발 함정).
  - 착시 보정: 버튼 세로 padding을 옆 입력보다 2px 작게.
    (추가/수정 폼 입력 8px→버튼 6px, 기간 편집기 입력 4px→버튼 2.5px)
- 적용 대상: `.ptask-form` / `.task-edit-form` / `.gantt-range-editor`. 개인/팀 복제라 양쪽 다.

## 작업 메모 — 커밋 (Windows)
- 여러 줄 커밋 메시지에 PowerShell here-string(`@'...'@`)을 bash에서 쓰지 말 것.
  메시지에 `@` 가 섞여 들어간 사고 있었음. 파일로 넘기거나(`git commit -F msg.txt`)
  `-m` 을 줄마다 반복할 것.

## 프로젝트 목록 순서/완료 (드래그 정렬)
- 프로젝트 문서의 추가 필드는 셋: `done`(완료 영역인가) · `order`(영역 안 위치) ·
  `doneAt`(처음 완료한 시각). 셋 다 없는 옛 문서는 "진행 중 · createdAt 순" 으로 정렬돼
  붙이기 전과 순서가 같다 — **백필·마이그레이션 불필요.**
- 계산은 전부 `projectOrder.js`(순수 모듈), 포인터/DOM 은 `projectDrag.js`.
  개인·팀은 코드 복제 관례를 유지하되 **이 두 가지만 공용**이다(150줄 복제 회피 +
  로그인 없이 `node --test projectOrder.test.mjs` 로 검증 가능).
- ⚠ **`doneAt` 은 완료 여부가 실제로 바뀐 문서에만 쓴다.** 순서만 바꿀 때마다 덮으면
  처음 완료한 시각이 매번 사라진다. 규칙은 `orderWriteFields()` 에 고정돼 있고 유닛 테스트가
  지킨다 — 직접 `{done, order, doneAt}` 을 조립하지 말고 그 함수를 쓸 것.
- ⚠ **드래그 중에는 재렌더를 보류한다**(`isDraggingProjects`/`pendingRender`).
  스냅샷이 와서 다시 그리면 끌고 있던 카드가 DOM 에서 교체돼 드래그가 끊긴다(간트 전례).
- ⚠ **자동 스크롤 중에는 `overflow-anchor:none` 을 걸어야 한다.** 안 그러면 브라우저의
  스크롤 앵커링이 scrollTop 을 되돌려 제 속도의 절반도 못 내고 맨 위에 닿지도 못한다.
- ⚠ 손잡이에는 `data-action="drag"` 를 달고 클릭 위임에서 먼저 걸러낸다. 없으면 손잡이
  클릭과 드래그 직후의 click 이 "프로젝트 선택" 으로 샌다.

## ⚠ 함께 배포·새로고침해야 하는 파일 묶음
- `projectOrder.js` · `projectDrag.js` · `personalProjects.js` · `teamProjects.js` ·
  `dataTransfer.js` — 서로 import 로 물려 있다.
- 하나라도 빠지거나 **캐시가 엇갈리면** `does not provide an export named ...` 로 모듈이
  통째로 죽고 화면이 텅 빈다(실제로 겪음). 커밋은 한 번에, 확인은 강제 새로고침으로.
- `projectOrder.js` 는 index.html 에 `<script>` 로 넣지 않는다(두 모듈이 import 한다).
  그래서 눈에 안 띄지만 빠지면 앱이 죽는다.

## 백업/복원 (dataTransfer.js)
- 약속은 하나: **"배열 순서가 곧 표시 순서".** 내보내기는 화면과 같은 기준으로 정렬해
  늘어놓고, 가져오기는 파일의 배열 순서대로 번호를 매긴다. 양쪽 다 `assignSectionOrder()`
  하나를 쓴다 — 규칙이 갈라지면 왕복할 때마다 순서가 흔들린다.
- 두 필드가 없는 옛 백업 파일은 자연히 "전부 진행 중 · order = 배열 인덱스" 가 된다.
  옛 내보내기가 createdAt 순이었으므로 그때 순서가 그대로 살아난다(분기 불필요).
- `doneAt` 은 **모르면 쓰지 않는다.** 가져오기 시각을 대신 넣으면 그게 곧 덮어쓰기다.

## 작업 메모 — 줄바꿈(CRLF)
- 작업 트리는 CRLF(`core.autocrlf=true`). 스크립트로 파일을 다시 쓸 때 파이썬이면
  `open(..., newline="")` 로 읽고 쓸 것. 안 하면 **파일 전체가 LF 로 바뀌어** diff 가
  통째로 뒤집힌다(한 번 겪고 되돌림).

## 작업 메모 — 로그인 없이 검증하기
- 구글 팝업 로그인이라 에이전트가 실계정으로 확인할 수 없다. 그래서 **로컬 전용 하네스**를
  쓴다(전부 `.gitignore` — 저장소 루트가 그대로 배포되므로 커밋하면 같이 올라간다):
  `drag-harness.html`(개인 드래그) · `team-drag-harness.html`(팀) · `data-harness.html`(백업)
  · `_fakeFirebase.js`(가짜 Firestore). import map 으로 gstatic 의 firebase 세 URL 만
  가짜로 돌려서 **앱 모듈은 고치지 않은 진짜 파일**이 그대로 돈다.
- Chrome 확장이 안 붙어도 검증할 수 있다 — 헤드리스 Chrome 을 CDP 로 직접 몰면 된다.
  함정 둘: `--user-data-dir` 에 **절대경로**(상대경로면 원격 디버깅을 거부한다) ·
  `--disable-background-timer-throttling --disable-renderer-backgrounding
  --disable-backgrounding-occluded-windows`(안 주면 rAF 가 눌려 자동 스크롤 측정이 무의미).
- 헤드리스에서 `alert`/`confirm` 을 그대로 두면 페이지가 멈춘다 — 하네스가 가로챈다.
