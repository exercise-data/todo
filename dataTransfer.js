// 7단계: 데이터 내보내기 / 가져오기 (개인용·팀용 각각)
//
// _reference_old(app.js)의 localStorage 백업/복원을 클라우드(Firestore) 구조로 이식한다.
//  - 내보내기: 대상(개인 또는 선택된 팀)의 projects+tasks 를
//      { version, exportedAt, scope, projects, tasks } JSON 으로 다운로드.
//  - 가져오기: 파일 읽기 → isValidBackup 검증 → 확인 → 대상 scope "전체 교체"(병합 아님).
//      기존 문서를 모두 지우고, id 를 새로 발급 + task.projectId 를 리매핑해 Firestore 에 기록.
//      ※ 덮어쓰기이므로 반드시 confirm 으로 확인을 받는다.
//
// scope 는 데이터 영역 단위다(개인 전체 / 특정 팀 전체) — 원본의 "구분(category)별 백업"과 다름.
// 카테고리 값은 그대로 보존한다(개인=daily 또는 추가 id, 팀=research/work 또는 추가 id).
// 다른 영역으로 교차 가져오기 시 카테고리가 그 탭의 필터와 안 맞을 수 있으나(회색 배지로 표시)
// 데이터 충실도를 위해 변형하지 않는다.
//
// 인증/Firebase 앱은 auth.js 가 초기화한 것을 재사용한다(다른 모듈과 동일 패턴).
// import 후 화면 갱신은 각 모듈의 onSnapshot 구독이 자동으로 처리하므로 별도 재렌더는 없다.

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
  getDocs,
  doc,
  writeBatch,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { describeError } from "./cloudErrors.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const EXPORT_VERSION = 1;
const SELECT_EVENT = "team-project-selected"; // teamId 만 사용

// 컬렉션 이름 (영역별)
const COLLS = {
  personal: { projects: "personalProjects", tasks: "personalTasks" },
  team: { projects: "teamProjects", tasks: "teamTasks" },
};

// ----- DOM 참조 -----
// 데이터 버튼은 상단 헤더(.header-data-tools)로 옮겨졌으므로 문서 전역에서 조회한다
// (클래스명이 고유해 충돌 없음). 팀 선택 <select> 는 여전히 .team-screen 안에 있다.
const pExportBtn = document.querySelector(".pdata-export");
const pImportBtn = document.querySelector(".pdata-import");
const pFileInput = document.querySelector(".pdata-file");
const tExportBtn = document.querySelector(".tdata-export");
const tImportBtn = document.querySelector(".tdata-import");
const tFileInput = document.querySelector(".tdata-file");
const teamSelectEl = document.querySelector(".team-screen .team-select");

// ----- 상태 -----
let currentUid = null;
let currentTeamId = null;

// ----- 유틸 -----
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function sanitizeFilename(name) {
  return (
    (name || "export").replace(/[\\/:*?"<>|]/g, "_").trim() || "export"
  );
}
// createdAt(Firestore Timestamp)을 millis 로. 없으면 null.
function createdMillis(v) {
  return v && typeof v.toMillis === "function" ? v.toMillis() : null;
}
// 내보낼 createdAt(millis|null)을 Firestore 기록값으로. millis 면 Timestamp 로 복원해
// 원래 정렬 순서를 보존, 없으면 serverTimestamp().
function createdValue(ms) {
  return typeof ms === "number" && isFinite(ms)
    ? Timestamp.fromMillis(ms)
    : serverTimestamp();
}
function downloadJson(obj, filename) {
  const json = JSON.stringify(obj, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 파싱 객체가 가져오기에 쓸 수 있는 형식인지 (원본 isValidBackup 이식)
function isValidBackup(data) {
  return (
    data &&
    typeof data === "object" &&
    Array.isArray(data.projects) &&
    Array.isArray(data.tasks)
  );
}

// 선택된 팀 id. 이벤트(currentTeamId)를 우선하되, 초기 이벤트를 놓친 경우를 대비해
// 팀 선택 <select> 값으로 폴백한다.
function getTeamId() {
  return currentTeamId || (teamSelectEl && teamSelectEl.value) || null;
}

// 선택된 팀 이름(파일명용). 없으면 teamId.
function currentTeamName() {
  const opt = teamSelectEl && teamSelectEl.selectedOptions
    ? teamSelectEl.selectedOptions[0]
    : null;
  return (opt && opt.textContent.trim()) || getTeamId() || "team";
}

// writeBatch 는 1회 500 op 제한 → 청크로 나눠 커밋.
async function commitOps(ops) {
  const CHUNK = 450;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const batch = writeBatch(db);
    ops.slice(i, i + CHUNK).forEach((op) => {
      if (op.type === "delete") batch.delete(op.ref);
      else batch.set(op.ref, op.data);
    });
    await batch.commit();
  }
}

// ===== 내보내기 =====
// area: "personal" | "team". 대상 영역의 projects+tasks 를 JSON 으로 다운로드.
async function exportArea(area) {
  const { projects: PCOLL, tasks: TCOLL } = COLLS[area];
  const teamId = getTeamId();
  const field = area === "personal" ? "ownerUid" : "teamId";
  const value = area === "personal" ? currentUid : teamId;

  if (!currentUid) {
    alert("로그인 후 이용할 수 있습니다.");
    return;
  }
  if (area === "team" && !teamId) {
    alert("먼저 팀을 선택하세요.");
    return;
  }

  try {
    const [projSnap, taskSnap] = await Promise.all([
      getDocs(query(collection(db, PCOLL), where(field, "==", value))),
      getDocs(query(collection(db, TCOLL), where(field, "==", value))),
    ]);

    // createdAt 순으로 정렬해 배열 순서 = 원래 순서가 되도록(가져오기 시 순서 보존)
    const projects = projSnap.docs
      .map((d) => {
        const x = d.data();
        return {
          id: d.id,
          name: x.name || "",
          category: x.category || "",
          createdAt: createdMillis(x.createdAt),
        };
      })
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    const tasks = taskSnap.docs
      .map((d) => {
        const x = d.data();
        return {
          id: d.id,
          projectId: x.projectId || "",
          title: x.title || "",
          startDate: x.startDate || "",
          endDate: x.endDate || "",
          completed: !!x.completed,
          createdAt: createdMillis(x.createdAt),
        };
      })
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    const scope =
      area === "personal"
        ? { type: "personal" }
        : { type: "team", teamId, teamName: currentTeamName() };

    const payload = {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      scope,
      projects,
      tasks,
    };

    const namePart =
      area === "personal" ? "personal" : sanitizeFilename(currentTeamName());
    downloadJson(payload, `backup-${namePart}-${toYMD(new Date())}.json`);
  } catch (err) {
    console.error("데이터 내보내기 실패:", err);
    alert("데이터 내보내기에 실패했습니다: " + describeError(err));
  }
}

// ===== 가져오기 =====
// area: "personal" | "team". 파일을 읽어 검증·확인 후 대상 영역 전체를 교체.
function importAreaFromFile(area, file) {
  const { projects: PCOLL, tasks: TCOLL } = COLLS[area];
  const teamId = getTeamId();
  const ownerField = area === "personal" ? "ownerUid" : "teamId";
  const ownerValue = area === "personal" ? currentUid : teamId;
  const areaLabel = area === "personal" ? "개인용" : "팀 공용";

  if (!currentUid) {
    alert("로그인 후 이용할 수 있습니다.");
    return;
  }
  if (area === "team" && !teamId) {
    alert("먼저 팀을 선택하세요.");
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);

      if (!isValidBackup(data)) {
        alert(
          "올바른 백업 파일이 아닙니다. (projects·tasks 배열을 찾을 수 없습니다)\n" +
            "기존 데이터는 그대로 유지됩니다."
        );
        return;
      }

      // 파일 scope 가 대상 영역과 다르면 안내 후 진행(영역 강제 적용)
      const fileType = data.scope && data.scope.type;
      if (fileType && fileType !== area) {
        const fromLabel = fileType === "personal" ? "개인용" : "팀 공용";
        const coerce = confirm(
          `이 파일은 '${fromLabel}' 백업입니다.\n` +
            `'${areaLabel}' 영역으로 가져오면 '${areaLabel}'에 들어갑니다. 계속할까요?`
        );
        if (!coerce) return;
      }

      // 유효한 프로젝트만(이름 있는 것), 그에 속한 할 일만(projectId 매칭)
      const baseProjects = data.projects.filter(
        (p) => p && p.id && (p.name || "").toString().trim()
      );
      const baseIds = new Set(baseProjects.map((p) => p.id));
      const baseTasks = data.tasks.filter((t) => t && baseIds.has(t.projectId));

      const targetName =
        area === "team" ? `'${currentTeamName()}' 팀` : "개인";
      const ok = confirm(
        `${targetName}의 기존 데이터를 모두 덮어씁니다(병합 아님). 계속할까요?\n` +
          `프로젝트 ${baseProjects.length}개 · 할 일 ${baseTasks.length}개를 가져옵니다.\n` +
          (area === "team"
            ? "같은 팀의 다른 구성원에게도 즉시 반영됩니다."
            : "이 작업은 되돌릴 수 없습니다.")
      );
      if (!ok) return;

      // 1) 기존 대상 문서 조회(삭제 대상)
      const [oldProj, oldTask] = await Promise.all([
        getDocs(query(collection(db, PCOLL), where(ownerField, "==", ownerValue))),
        getDocs(query(collection(db, TCOLL), where(ownerField, "==", ownerValue))),
      ]);

      const ops = [];
      oldProj.forEach((d) => ops.push({ type: "delete", ref: d.ref }));
      oldTask.forEach((d) => ops.push({ type: "delete", ref: d.ref }));

      // 2) id 재발급 + projectId 리매핑하여 새 문서 생성
      const idMap = {};
      baseProjects.forEach((p) => {
        const ref = doc(collection(db, PCOLL));
        idMap[p.id] = ref.id;
        const base = {
          name: (p.name || "").toString(),
          category: (p.category || "").toString(),
          createdAt: createdValue(p.createdAt),
        };
        const data2 =
          area === "personal"
            ? { ownerUid: currentUid, ...base }
            : { teamId, createdBy: currentUid, ...base };
        ops.push({ type: "set", ref, data: data2 });
      });

      baseTasks.forEach((t) => {
        const newPid = idMap[t.projectId];
        if (!newPid) return; // 매칭 프로젝트 없으면 건너뜀
        const ref = doc(collection(db, TCOLL));
        const base = {
          projectId: newPid,
          title: (t.title || "").toString(),
          startDate: (t.startDate || "").toString(),
          endDate: (t.endDate || "").toString(),
          completed: !!t.completed,
          createdAt: createdValue(t.createdAt),
        };
        const data2 =
          area === "personal"
            ? { ownerUid: currentUid, ...base }
            : { teamId, createdBy: currentUid, ...base };
        ops.push({ type: "set", ref, data: data2 });
      });

      await commitOps(ops);
      alert(`${areaLabel} 데이터를 가져왔습니다. (프로젝트 ${baseProjects.length} · 할 일 ${baseTasks.length})`);
    } catch (err) {
      console.error("데이터 가져오기 실패:", err);
      alert(
        "가져오기에 실패했습니다(손상된 JSON이거나 권한 문제). 기존 데이터는 그대로일 수 있습니다.\n" +
          describeError(err)
      );
    }
  };
  reader.onerror = () => {
    console.error("파일 읽기 실패:", reader.error);
    alert("파일을 읽지 못했습니다. 기존 데이터는 그대로 유지됩니다.");
  };
  try {
    reader.readAsText(file);
  } catch (err) {
    console.error("파일 읽기 시작 실패:", err);
    alert("파일을 읽지 못했습니다. 기존 데이터는 그대로 유지됩니다.");
  }
}

// ----- 버튼/파일 입력 연결 -----
pExportBtn.addEventListener("click", () => exportArea("personal"));
pImportBtn.addEventListener("click", () => pFileInput.click());
pFileInput.addEventListener("change", () => {
  const file = pFileInput.files && pFileInput.files[0];
  if (file) importAreaFromFile("personal", file);
  pFileInput.value = ""; // 같은 파일 연속 선택도 change 발생하도록
});

tExportBtn.addEventListener("click", () => exportArea("team"));
tImportBtn.addEventListener("click", () => tFileInput.click());
tFileInput.addEventListener("change", () => {
  const file = tFileInput.files && tFileInput.files[0];
  if (file) importAreaFromFile("team", file);
  tFileInput.value = "";
});

// ----- 선택된 팀 추적 (teamProjects.js 발행) -----
document.addEventListener(SELECT_EVENT, (e) => {
  currentTeamId = (e.detail && e.detail.teamId) || null;
});

// ----- 인증 상태 -----
onAuthStateChanged(auth, (user) => {
  currentUid = user ? user.uid : null;
  if (!user) currentTeamId = null;
});
