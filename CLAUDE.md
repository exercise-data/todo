# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A Korean-language project & task manager ("할 일 관리") that runs entirely in the browser with no build step, no dependencies, and no backend. State lives in `localStorage`. Three files: `index.html` (static markup shell), `styles.css` (all styling + CSS variables), `app.js` (all logic).

## Running & checking

- **Run:** open `index.html` directly in a browser (no server required). UTF-8 and Korean fonts are assumed.
- **Syntax check:** `node --check app.js` — the only "build"/lint step. Do this after editing `app.js`.
- There is no test framework. Ad-hoc browser-driving scripts (`_drive*.py`, `_check.py`) were used for manual verification and are not committed source.

## Architecture

`app.js` is a single IIFE-free script split into numbered "단계" (stage) sections. Read it top-to-bottom; ordering matters because module-level code runs at load.

**Data model (two flat arrays, persisted as JSON):**
- `projects[]`: `{ id, name, category("work"|"personal"|"study"), createdAt }`
- `tasks[]`: `{ id, projectId, title, startDate, endDate, completed, createdAt }` — dates are `"YYYY-MM-DD"` strings, sortable/comparable lexicographically (relied on throughout).
- Tasks reference projects by `projectId`; deleting a project cascades to its tasks only.

**Persistence layer** (`STORAGE_KEYS`, `save`/`load`/`loadArray`): four separate `localStorage` keys — bulk data (`projects`, `tasks`) is saved together via `save()`, while lightweight UI state (`selectedProjectId`, per-project gantt axis units) is persisted separately so selecting a project doesn't rewrite all data. All loads are defensive: corrupt/missing JSON falls back to empty.

**UI state vs. data:** module-level `let` vars (`selectedProjectId`, `editingProjectId`, `editingTaskId`, `currentFilter`, `taskView`, `ganttUnits`) hold transient view state. Only `selectedProjectId` and `ganttUnits` are persisted.

**Rendering model:** full re-render on every change — no virtual DOM, no diffing. The functions `renderProjects()`, `renderTaskList()`, `renderGantt()` (and the `renderTasks()` dispatcher that calls the latter two) clear their container's `innerHTML` and rebuild from the arrays. After any mutation, call `save()` then the relevant render functions. Note the cross-dependency: changing tasks must also `renderProjects()` because the left panel shows per-project progress bars (`getProgress()` computes percent on the fly, never stored).

**Event handling:** delegated listeners on container elements (`.project-list`, `.task-list`, `.gantt`, tab bars), dispatching on `data-action` / `data-id` / `data-category` attributes set during render. Inline edit forms are rendered in place of an item when its id matches `editingProjectId`/`editingTaskId`.

**Gantt chart** (`renderGantt` and helpers): builds a CSS-grid timeline. Axis unit (`day`/`week`/`month`) is either auto-picked from the total span (`pickUnit`) or forced per-project via `ganttUnits[projectId]`. `buildPeriods()` generates the columns; columns use `1fr` so everything fits one screen (no horizontal scroll). Only tasks with valid `startDate <= endDate` appear; others are counted and reported below the chart.

**Korean holidays** (`FIXED_HOLIDAYS`, `LUNAR_HOLIDAYS`, `getYearHolidays`): day-unit gantt cells shade weekends and Korean public holidays. Solar holidays are fixed MM-DD; lunar holidays (설날/추석/부처님오신날) are hardcoded per year **2024–2030 only** — outside that range, lunar holidays silently don't render. Substitute-holiday (대체공휴일) rules are computed in `getYearHolidays`. If extending years, add entries to `LUNAR_HOLIDAYS`.

## Conventions

- Code, comments, and all UI text are Korean. Match this when editing. Comments reference requirement IDs (FR-01…FR-07).
- Keep the zero-dependency, single-file-per-concern structure. Don't introduce a framework, bundler, or npm packages.
- Date logic treats `"YYYY-MM-DD"` strings as both sortable keys and `new Date(`${ymd}T00:00:00`)` inputs — preserve this format.
