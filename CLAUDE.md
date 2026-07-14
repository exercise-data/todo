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
