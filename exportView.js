// 8단계: 현재 보기(목록/간트차트)를 PNG·PDF로 저장 — _reference_old(app.js) 방식 그대로 이식.
//
// 외부 라이브러리 없이 브라우저 기본 API만 사용한다.
//   - 화면을 그대로 복제 → 계산된 스타일을 인라인 복사 → 컨트롤 제거 → 흰 카드(제목·기간)로 감쌈
//   - SVG <foreignObject> 로 2배 해상도 래스터화 → <canvas>
//   - PNG = canvas.toBlob, PDF = 캔버스를 JPEG 로 인코딩해 최소 구조 PDF 에 그림 XObject 삽입
//
// 개인용·팀 공용 양쪽의 세부 할일 패널(.pproj-detail)에 동일하게 적용한다.
// 각 패널은 자기 자신의 .ptask-list / .ptask-gantt 만 내보낸다(루트 스코프).
// 현재 보기는 활성 탭(.view-tab.is-active)으로 판정: 목록이면 목록, 간트면 간트.
//
// ★ Chromium/Firefox 에서만 동작. Safari 는 foreignObject→canvas 가 빈/오염 이미지가 됨.
//   (버튼 근처에 안내 문구를 둔다.)
//
// Firebase 와 무관한 순수 DOM/Canvas 모듈 — 다른 모듈과 DOM(클래스)만 공유한다.

const EXPORT_SCALE = 2; // 선명도를 위해 2배 해상도로 래스터화
const EXPORT_PAD = 16; // 카드 내부 여백(px)

// 파일명에 쓸 수 없는 문자를 _ 로 치환
function sanitizeFilename(name) {
  return (name || "export").replace(/[\\/:*?"<>|]/g, "_").trim() || "export";
}

// 라이브 요소의 계산된 스타일을 같은 구조의 복제본에 인라인으로 복사.
// 복제본은 cloneNode(true) 결과여서 라이브와 노드 순서가 1:1로 대응한다.
function inlineStylesFromLive(liveRoot, cloneRoot) {
  const liveEls = [liveRoot, ...liveRoot.querySelectorAll("*")];
  const cloneEls = [cloneRoot, ...cloneRoot.querySelectorAll("*")];
  const n = Math.min(liveEls.length, cloneEls.length);
  for (let i = 0; i < n; i++) {
    const cs = getComputedStyle(liveEls[i]);
    let text = "";
    for (let j = 0; j < cs.length; j++) {
      const prop = cs[j];
      text += `${prop}:${cs.getPropertyValue(prop)};`;
    }
    cloneEls[i].setAttribute("style", text);
  }
}

// 보기 컨텐츠를 흰 카드로 감싼 내보내기용 DOM을 만든다.
//   view: "list" | "gantt", listEl/ganttEl: 해당 패널의 라이브 컨테이너
//   ganttToolbarEl: 간트의 고정 도구막대(스크롤 박스 '밖'). 주말/공휴일 범례가 여기 있어
//     ganttEl 복제만으로는 내보내기에 안 실린다 → 아래에서 따로 복제해 카드에 붙인다.
function buildExportCard(view, listEl, ganttEl, projectName, rangeLabel, ganttToolbarEl) {
  let liveContainer;
  if (view === "gantt") {
    if (!ganttEl.querySelector(".gantt-grid")) return null;
    liveContainer = ganttEl;
  } else {
    if (!listEl.querySelector(".task-item")) return null;
    liveContainer = listEl;
  }

  // 현재 화면 너비를 기준으로 컨텐츠 너비 고정 (간트 1fr 칸이 찌그러지지 않도록)
  const widthRef =
    view === "gantt" ? ganttEl.querySelector(".gantt-grid") : listEl;
  const contentWidth = Math.ceil(widthRef.getBoundingClientRect().width);

  const clone = liveContainer.cloneNode(true);
  inlineStylesFromLive(liveContainer, clone);

  // 체크박스 완료 상태는 속성이 아닌 프로퍼티라 복제에 안 실림 → 직접 반영
  if (view === "list") {
    const liveChecks = liveContainer.querySelectorAll(".task-check");
    const cloneChecks = clone.querySelectorAll(".task-check");
    liveChecks.forEach((c, i) => {
      if (!cloneChecks[i]) return;
      if (c.checked) cloneChecks[i].setAttribute("checked", "checked");
      else cloneChecks[i].removeAttribute("checked");
    });
  }

  // 내보내기에 불필요한 요소 제거 (인라인 후에 제거해야 스타일 대응이 어긋나지 않음)
  if (view === "gantt") {
    clone
      .querySelectorAll(".gantt-controls, .gantt-note, .gantt-resizer")
      .forEach((el) => el.remove());
  } else {
    clone
      .querySelectorAll(".task-actions, .list-note")
      .forEach((el) => el.remove());
  }

  // 주말/공휴일 범례는 가로 스크롤에 밀리지 않도록 스크롤 박스 '밖'의 고정 도구막대로 옮겼다.
  // 그래서 ganttEl 복제본에는 안 들어온다 → 도구막대에서 따로 복제해 차트 아래에 되붙인다.
  // (도구막대의 나머지 컨트롤은 내보내기 대상이 아니므로 범례만 골라 온다.)
  if (view === "gantt" && ganttToolbarEl) {
    const liveLegend = ganttToolbarEl.querySelector(".gantt-legend");
    if (liveLegend) {
      const legendClone = liveLegend.cloneNode(true);
      inlineStylesFromLive(liveLegend, legendClone);
      // 도구막대에선 margin:0 (간격을 flex gap 이 맡음) → 카드에선 예전처럼 여백을 준다
      legendClone.style.margin = "10px";
      // ★ inlineStylesFromLive 는 '도구막대에서 실제로 잡힌 폭'까지 인라인으로 복사한다.
      //   그 폭이 카드 안(SVG foreignObject 래스터화 — 글자 폭이 미세하게 달라진다)에서 1px만
      //   모자라도 마지막 항목이 다음 줄로 밀린다. 폭은 내용에 맞게 다시 잡히도록 풀어 준다.
      //   (스와치 .lg 의 14px 은 CSS 로 못박은 값이라 그대로 둔다.)
      legendClone.style.width = "auto";
      legendClone
        .querySelectorAll(".lg-item")
        .forEach((it) => (it.style.width = "auto"));
      clone.append(legendClone);
    }
  }

  // 복제본 루트의 스크롤/높이 제약 해제 → 전체 내용이 잘리지 않고 펼쳐짐
  clone.style.overflow = "visible";
  clone.style.height = "auto";
  clone.style.maxHeight = "none";
  clone.style.flex = "none";
  clone.style.border = "none";
  clone.style.width = `${contentWidth}px`;
  clone.style.margin = "8px auto 0"; // 가로 중앙 정렬
  clone.classList.remove("is-hidden");

  // 헤더: 제목(프로젝트명) + 기간
  const header = document.createElement("div");
  header.style.textAlign = "center";
  header.style.color = "#1f2430";

  const title = document.createElement("div");
  title.style.fontSize = "18px";
  title.style.fontWeight = "700";
  title.textContent = projectName;

  const period = document.createElement("div");
  period.style.fontSize = "12px";
  period.style.color = "#6b7280";
  period.style.marginTop = "2px";
  period.textContent = `기간: ${rangeLabel || "전체"}`;

  header.append(title, period);

  // 흰 카드 컨테이너 (내용이 곧 이미지 전체 → 여백 최소)
  const card = document.createElement("div");
  Object.assign(card.style, {
    display: "inline-block",
    boxSizing: "border-box",
    background: "#ffffff",
    padding: `${EXPORT_PAD}px`,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif',
  });
  card.append(header, clone);
  return card;
}

// 카드 DOM을 SVG <foreignObject>로 그려 캔버스로 래스터화. { canvas, cssW, cssH } 반환.
function rasterizeCard(card) {
  return new Promise((resolve, reject) => {
    // 화면 밖에 잠시 붙여 레이아웃을 잡고 크기를 측정
    card.style.position = "fixed";
    card.style.left = "-100000px";
    card.style.top = "0";
    document.body.append(card);
    const rect = card.getBoundingClientRect();
    const cssW = Math.ceil(rect.width);
    const cssH = Math.ceil(rect.height);
    // 측정용 화면 밖 위치 지정을 해제하고 직렬화해야 한다.
    // (이 스타일이 남으면 SVG 안에서 카드가 화면 밖으로 그려져 빈 이미지가 됨)
    card.style.position = "";
    card.style.left = "";
    card.style.top = "";
    const inner = new XMLSerializer().serializeToString(card);
    document.body.removeChild(card);

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cssW * EXPORT_SCALE}" ` +
      `height="${cssH * EXPORT_SCALE}" viewBox="0 0 ${cssW} ${cssH}">` +
      `<foreignObject x="0" y="0" width="${cssW}" height="${cssH}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml">${inner}</div>` +
      `</foreignObject></svg>`;

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = cssW * EXPORT_SCALE;
      canvas.height = cssH * EXPORT_SCALE;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; // 배경 흰색
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      resolve({ canvas, cssW, cssH });
    };
    img.onerror = () => reject(new Error("이미지 변환에 실패했습니다."));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

// Blob을 파일로 다운로드
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// data URL의 base64 부분을 바이트 배열로 디코드
function dataURLToBytes(dataURL) {
  const bin = atob(dataURL.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// JPEG 한 장을 한 페이지에 채운 최소 구조의 PDF 바이트를 만든다.
//   imgW/imgH: JPEG 픽셀 크기, cssW/cssH: 페이지 환산용 CSS 픽셀 크기
function buildPdf(jpegBytes, imgW, imgH, cssW, cssH) {
  // 96px/inch(화면) → 72pt/inch(PDF): 1px = 0.75pt.
  const pageW = +(cssW * 0.75).toFixed(2);
  const pageH = +(cssH * 0.75).toFixed(2);

  // 문자열을 latin1(1바이트/문자) 바이트로 — PDF 구조부는 모두 ASCII
  const enc = (s) => {
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
    return a;
  };

  const chunks = [];
  let len = 0;
  const offsets = {};
  const push = (data) => {
    const b = typeof data === "string" ? enc(data) : data;
    chunks.push(b);
    len += b.length;
  };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  offsets[1] = len;
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  offsets[2] = len;
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

  offsets[3] = len;
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Contents 5 0 R /Resources << /XObject << /Im0 4 0 R >> >> >>\nendobj\n`
  );

  offsets[4] = len;
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} ` +
      `/Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
      `/Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
  );
  push(jpegBytes);
  push("\nendstream\nendobj\n");

  const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
  offsets[5] = len;
  push(
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`
  );

  const xrefStart = len;
  const count = 6; // 객체 0..5
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  push(xref);
  push(
    `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  );

  // 모든 청크를 하나의 바이트 배열로 합치기
  const out = new Uint8Array(len);
  let pos = 0;
  for (const b of chunks) {
    out.set(b, pos);
    pos += b.length;
  }
  return out;
}

// 패널(.pproj-detail)에서 현재 보기/제목/기간을 읽어온다.
function readPanel(root) {
  const activeTab = root.querySelector(".view-tab.is-active");
  const view = activeTab && activeTab.dataset.ptview === "gantt" ? "gantt" : "list";
  const listEl = root.querySelector(".ptask-list");
  const ganttEl = root.querySelector(".ptask-gantt");
  const ganttToolbarEl = root.querySelector(".ptask-gantt-toolbar");
  const nameEl = root.querySelector(".pproj-detail-name");
  const projectName = (nameEl && nameEl.textContent.trim()) || "내보내기";

  // 표시 기간: 보이는 보기의 기간 태그(.gantt-range-tag) 텍스트에서 추출, 없으면 "전체".
  // ★ 간트의 기간 태그는 ganttEl(스크롤 박스) 이 아니라 그 위 고정 도구막대에 있다.
  //   예전엔 ganttEl 에서 찾다가 늘 못 찾아, 기간을 설정해도 내보내기에는 "전체"로 찍혔다.
  //   (목록은 예전 그대로 .ptask-list-toolbar 에서 찾는다.)
  const scopeEl =
    view === "gantt" ? ganttToolbarEl : root.querySelector(".ptask-list-toolbar");
  const tag = scopeEl ? scopeEl.querySelector(".gantt-range-tag") : null;
  const rangeLabel = tag
    ? tag.textContent.replace(/^표시 기간:\s*/, "").trim()
    : "전체";

  return { view, listEl, ganttEl, ganttToolbarEl, projectName, rangeLabel };
}

// 메인 진입점: 패널의 현재 보기를 format("png"|"pdf")으로 저장
async function exportPanel(root, format) {
  if (!root.classList.contains("has-project")) {
    alert("먼저 왼쪽에서 프로젝트를 선택하세요.");
    return;
  }
  const { view, listEl, ganttEl, ganttToolbarEl, projectName, rangeLabel } =
    readPanel(root);

  const card = buildExportCard(
    view,
    listEl,
    ganttEl,
    projectName,
    rangeLabel,
    ganttToolbarEl
  );
  if (!card) {
    alert("내보낼 내용이 없습니다.");
    return;
  }

  const viewLabel = view === "gantt" ? "간트차트" : "목록";
  const base = `${sanitizeFilename(projectName)}_${viewLabel}`;

  try {
    const { canvas, cssW, cssH } = await rasterizeCard(card);
    if (format === "png") {
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `${base}.png`);
        else alert("PNG 생성에 실패했습니다.");
      }, "image/png");
    } else {
      const jpeg = dataURLToBytes(canvas.toDataURL("image/jpeg", 0.95));
      const pdf = buildPdf(jpeg, canvas.width, canvas.height, cssW, cssH);
      downloadBlob(new Blob([pdf], { type: "application/pdf" }), `${base}.pdf`);
    }
  } catch (err) {
    console.error("내보내기 실패:", err);
    alert("내보내기에 실패했습니다. 브라우저 콘솔을 확인하세요.");
  }
}

// ----- 개인/팀 양쪽 세부 할일 패널의 PNG/PDF 버튼 연결 -----
document.querySelectorAll(".pproj-detail").forEach((root) => {
  const group = root.querySelector(".ptask-export");
  if (!group) return;
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-export]");
    if (!btn) return;
    exportPanel(root, btn.dataset.export);
  });
});
