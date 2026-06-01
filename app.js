// 할 일 관리 앱
// 2단계: 데이터 모델과 localStorage 영속성. 화면 조작은 아직 연결하지 않는다.

// localStorage 저장 키
const STORAGE_KEY = "daylist.todos";

// 메모리 배열: 할 일 데이터를 보관한다.
// 할 일 1건 구조:
//   { id, title, category("work"|"personal"|"study"), completed(bool), createdAt(ISO) }
let todos = [];

// 할 일 1건을 생성한다.
function createTodo(title, category) {
  return {
    id: crypto.randomUUID(),
    title,
    category,
    completed: false,
    createdAt: new Date().toISOString(),
  };
}

// 메모리 배열을 localStorage에 저장한다.
function saveTodos() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  } catch (err) {
    console.error("할 일 저장에 실패했습니다.", err);
  }
}

// localStorage에서 할 일을 복원한다.
// 데이터가 없거나 손상됐으면 빈 배열로 안전하게 시작한다.
function loadTodos() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      todos = [];
      return todos;
    }
    const parsed = JSON.parse(raw);
    // 배열이 아니면 손상된 것으로 간주한다.
    todos = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("할 일 로드에 실패했습니다. 빈 목록으로 시작합니다.", err);
    todos = [];
  }
  return todos;
}

// 카테고리 코드 → 화면 표시용 한글 라벨
const CATEGORY_LABELS = {
  work: "업무",
  personal: "개인",
  study: "공부",
};

// DOM 참조
const inputEl = document.getElementById("todo-input");
const categoryEl = document.getElementById("category-select");
const addBtn = document.getElementById("add-btn");
const listEl = document.getElementById("todo-list");
const filtersEl = document.getElementById("filters");
const progressFillEl = document.getElementById("progress-fill");
const progressTextEl = document.getElementById("progress-text");

// 현재 선택된 필터: "all" | "work" | "personal" | "study"
let currentFilter = "all";

// 진행률을 갱신한다. (FR-06) 전체 기준으로 계산한다.
function renderProgress() {
  const total = todos.length;
  const done = todos.filter((t) => t.completed).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  progressFillEl.style.width = percent + "%";
  progressTextEl.textContent = percent + "%";
}

// todos 배열을 목록 영역에 그린다. 변경이 생길 때마다 호출한다.
function render() {
  renderProgress();
  listEl.innerHTML = "";

  // 현재 필터에 맞는 항목만 추린다. (FR-05)
  const visible =
    currentFilter === "all"
      ? todos
      : todos.filter((t) => t.category === currentFilter);

  // 정렬: 미완료를 위에, 완료를 아래에 배치한다. (안정 정렬)
  const sorted = visible
    .map((todo, index) => ({ todo, index }))
    .sort((a, b) => {
      if (a.todo.completed !== b.todo.completed) {
        return a.todo.completed ? 1 : -1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.todo);

  // 빈 상태 안내
  if (sorted.length === 0) {
    const empty = document.createElement("li");
    empty.className = "todo-empty";
    empty.textContent =
      todos.length === 0
        ? "할 일을 추가해 보세요"
        : "이 카테고리에는 할 일이 없습니다";
    listEl.appendChild(empty);
    return;
  }

  sorted.forEach((todo) => {
    const li = document.createElement("li");
    li.className = "todo" + (todo.completed ? " todo--done" : "");
    li.dataset.id = todo.id;

    // 완료 체크박스 (FR-04)
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "todo__check";
    checkbox.checked = todo.completed;
    checkbox.addEventListener("change", () => toggleTodo(todo.id));

    // 카테고리 뱃지
    const badge = document.createElement("span");
    badge.className = "todo__badge todo__badge--" + todo.category;
    badge.textContent = CATEGORY_LABELS[todo.category] || todo.category;

    // 제목 (더블클릭으로 수정 — FR-02)
    const titleEl = document.createElement("span");
    titleEl.className = "todo__title";
    titleEl.textContent = todo.title;
    titleEl.addEventListener("dblclick", () => startEdit(todo.id));

    // 수정 버튼 (FR-02)
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "todo__btn todo__edit";
    editBtn.textContent = "수정";
    editBtn.addEventListener("click", () => startEdit(todo.id));

    // 삭제 버튼 (FR-03)
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "todo__btn todo__delete";
    delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => deleteTodo(todo.id));

    li.append(checkbox, badge, titleEl, editBtn, delBtn);
    listEl.appendChild(li);
  });
}

// 추가 (FR-01): 입력값으로 새 할 일을 만든다. 공백만 입력하면 무시한다.
function addTodo() {
  const title = inputEl.value.trim();
  if (!title) return;

  todos.push(createTodo(title, categoryEl.value));
  saveTodos();
  render();

  inputEl.value = "";
  inputEl.focus();
}

// 완료 토글 (FR-04)
function toggleTodo(id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return;

  todo.completed = !todo.completed;
  saveTodos();
  render();
}

// 인라인 수정 시작 (FR-02): 제목을 입력 필드로 교체한다.
function startEdit(id) {
  const li = listEl.querySelector(`li[data-id="${id}"]`);
  const todo = todos.find((t) => t.id === id);
  if (!li || !todo) return;

  const titleEl = li.querySelector(".todo__title");
  if (!titleEl || li.querySelector(".todo__edit-input")) return;

  const editInput = document.createElement("input");
  editInput.type = "text";
  editInput.className = "todo__edit-input";
  editInput.value = todo.title;

  // 저장 처리 (한 번만 실행되도록 가드)
  let finished = false;
  const commit = (save) => {
    if (finished) return;
    finished = true;

    if (save) {
      const next = editInput.value.trim();
      if (next) {
        todo.title = next;
        saveTodos();
      }
    }
    render();
  };

  editInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  editInput.addEventListener("blur", () => commit(true));

  titleEl.replaceWith(editInput);
  editInput.focus();
  editInput.select();
}

// 삭제 (FR-03): 확인 후 해당 항목만 제거한다.
function deleteTodo(id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return;

  if (!confirm(`"${todo.title}" 항목을 삭제할까요?`)) return;

  todos = todos.filter((t) => t.id !== id);
  saveTodos();
  render();
}

// 이벤트 연결: 추가 버튼 + Enter 키 (FR-01)
addBtn.addEventListener("click", addTodo);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addTodo();
});

// 필터 탭 클릭 (FR-05): 선택한 카테고리만 보여주고 활성 탭을 강조한다.
filtersEl.addEventListener("click", (e) => {
  const tab = e.target.closest(".filters__tab");
  if (!tab) return;

  currentFilter = tab.dataset.filter;

  filtersEl.querySelectorAll(".filters__tab").forEach((t) => {
    t.classList.toggle("filters__tab--active", t === tab);
  });

  render();
});

// 페이지 로드 시 데이터를 복원하고 화면을 그린다.
loadTodos();
render();
