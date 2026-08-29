# Keelhaularr interface refinement plan

Source of truth: `DESIGN-IS-2026-08-29/00-scope.md` through `04-handoff-prompt.md`.

## Phase 0 — Documentation discovery

### Consolidated findings

- The frontend is one React 19 root using local state/effects and plain CSS. There is no router, UI kit, state library, client-query library, frontend test runner, or accessibility component dependency (`src/main.tsx:1-10`, `package.json:1-32`).
- Keep these component contracts intact:
  - `SettingsDialog({ onboarding?, onClose, onSaved })` (`src/SettingsDialog.tsx:435` before implementation)
  - `OperationsDialog({ initialTab?, onClose, onChanged, onJobQueued })` (`src/OperationsDialog.tsx:104` before implementation)
  - `DirectoryInput({ value, onChange, label, id?, placeholder?, allowNew? })` (`src/DirectoryInput.tsx:25-32`)
- Settings uses one authoritative parent `form` and one atomic full-payload save. UI grouping must not create independent state or a new server shape (`src/SettingsDialog.tsx:435-637`, `server/settings.mjs:214-340`).
- qBittorrent recovery must remain nested at `qbittorrent.recovery`. The existing connection and recovery ranges can be copied into separate presentation components while sharing the same `QBittorrentForm` and `onChange` (`src/SettingsDialog.tsx:375-429`).
- Scan truth is available from the unfiltered tab source, filtered `visible` array, connections, and warnings. No backend `complete` flag exists (`src/App.tsx:231-246`, `server/index.mjs:297-314`).
- Operations has only the documented REST endpoints. There is no SSE/WebSocket or active-only jobs query. Active-section loads and job-only polling must use the existing routes (`server/index.mjs:349-452`).
- `purgedQuarantineCount` already exists in `ScheduleState.lastReport` and scheduler output; displaying it needs no backend change (`src/OperationsDialog.tsx:57-61`, `server/scheduler.mjs:48-93`).
- Native `HTMLDialogElement.showModal()` is available in the installed DOM types and is the documented way to obtain top-layer modality, outside-content inertness, contained focus, Escape handling, and focus restoration. React supports built-in `<dialog>`, refs, effects, `onCancel`, and `onClose`.
- Manifest selectors are true tabs and should use the WAI-ARIA tab contract. Settings and Operations selectors can instead remain navigation controls with `aria-current="page"`, avoiding an unnecessary custom roving-tab implementation.

### Allowed APIs

- React: `useState`, `useMemo`, `useEffect`, `useRef`, `useCallback`; built-in `<dialog>` events and refs.
- DOM: `HTMLDialogElement.showModal()`, `HTMLDialogElement.close(returnValue?)`; native focus restoration and Escape behavior.
- Existing JSON `api<T>(url, options?)` helpers and the routes declared in `server/index.mjs:113-209,297-452`.
- Existing settings update helpers and the full `PUT /api/settings` payload.
- Existing CSS variables/primitives in `src/styles.css`; native `:focus-visible`, `::backdrop`, and media queries.
- Existing verification commands: `npm run build`, `npm test`, `git diff --check`.

### Documentation patterns to copy

- Native modal behavior: W3C WCAG Technique H102 and WAI-ARIA APG Modal Dialog Pattern.
- Tabs: WAI-ARIA APG Tabs Pattern; use roles/relationships and roving `tabIndex` only for the manifest's true tabs.
- Current navigation: MDN `aria-current`; do not use it on `role="tab"`.
- Skip link: W3C G1, first focusable link targeting a focusable main region.
- Focus ring: MDN `:focus-visible`, retaining a visible fallback.
- Current local form/list patterns: `src/SettingsDialog.tsx:267-331` and `src/DirectoryInput.tsx:25-157`.
- Current local polling/backoff pattern: `src/App.tsx:304-342`.

### Anti-pattern guards

- Do not add a router, UI framework, focus-trap package, query library, or remote dependency.
- Do not change backend routes, payloads, deletion semantics, automatic-recovery semantics, or qBittorrent category `''` handling.
- Do not use `aria-modal` on a hand-built overlay that still exposes the page; use native `showModal()`.
- Do not use `dialog.show()` or `<dialog open>` as a modal substitute.
- Do not add positive `tabIndex`, use `aria-current` on tabs, or retain a partial tablist contract.
- Do not equate `visible.length === 0` with a clean scan.
- Do not claim scheduled maintenance is report-only while retention cleanup runs.
- Do not invent job query parameters, SSE, WebSocket, or partial settings endpoints.
- Do not unconditionally mount Settings or Operations; their mount effects make network requests.
- Do not perform a wholesale formatting rewrite of the existing dirty UI files.

## Phase 1 — Interaction foundation and dashboard

### What to implement

1. Copy the W3C H102/native-dialog pattern into a small local reusable hook/component and apply it to confirmation, Settings, and Operations without adding dependencies. Keep initial focus on CANCEL for destructive confirmation; focus the dialog title/intro for long Settings and Operations content.
2. Add the W3C G1 skip-link pattern before the shell and give the dashboard main region a stable focusable target.
3. Copy the complete APG tab attributes into the manifest: `role="tab"`, `aria-selected`, `aria-controls`, matching panel IDs, and roving `0/-1`; implement Left/Right keyboard switching for its two tabs.
4. Refine the dashboard layout in `App.tsx` and existing CSS ownership sites:
   - compact the hero while retaining the product's nautical brand character;
   - expose exactly one primary `Scan Radarr & Sonarr` action;
   - remove the lower duplicate standing-orders panel;
   - retain three compact summary cells;
   - do not render search/minimum/sort/batch controls before a scan;
   - show the destructive selection action only when items are selected;
   - derive `source` separately and render `All clear` only when the source is truly empty, otherwise `No matching files` with a clear-filters action;
   - change operational copy to literal labels and make configured connection pills visibly named on mobile.
5. Consolidate the affected color/type/spacing rules at their existing CSS ownership sites. Add a shared focus-visible ring, correct normal-text/danger contrast, and raise compact mobile targets without causing body overflow.

### Documentation references

- W3C H102 and APG Modal Dialog Pattern.
- APG Tabs Pattern and keyboard-interface roving-tabindex guidance.
- W3C G1 and MDN `:focus-visible`.
- `src/App.tsx:143-188,231-246,304-342,410-515` before implementation.
- `src/styles.css:3-6,25-31` before implementation.

### Verification checklist

- `npm run build` passes.
- `npm test` remains green.
- `git diff --check` passes.
- Source inspection proves one scan button, no `.orders-panel` markup, result-only controls conditional on `scan`, separate source-vs-visible empty states, and complete manifest tab relationships.
- Desktop and 390px browser runs prove the manifest appears materially earlier, connection names remain visible, all enabled controls have visible focus, native dialogs contain focus and close on Escape, no body horizontal overflow, and existing delete/refresh flow still works.

### Anti-pattern guards

- Do not remove scan warnings, server revalidation copy, normal CONFIRM/CANCEL, selection safety, reduced motion, or job-driven auto-refresh.
- Do not hide a connection's name on mobile.
- Do not add a second primary scan action to the empty state.
- Do not infer a clean scan when warnings indicate withheld/incomplete data.

## Phase 2 — Settings and Operations information architecture

### What to implement

1. Copy the existing Operations navigation structure into a Settings-specific section navigator, using ordinary buttons plus `aria-current="page"`. Keep one focused group rendered at a time:
   - Connections (default in onboarding)
   - Cleanup rules
   - Automation
   - Account (omit during onboarding)
   - System
2. Keep one parent settings form and one global save. Copy the qBittorrent connection range and recovery range into separate components that receive the same `QBittorrentForm` and immutable update callback; do not alter persistence nesting.
3. Put Radarr, Sonarr, and qBittorrent connection fields in Connections; size/orphan rules in Cleanup; qB automatic replacement and scan/notification settings in Automation; deployment facts in System.
4. Simplify helper copy and use literal action/state labels from the audit. Correct the server-side persistence sentence.
5. Treat Operations selectors as navigation, not ARIA tabs: set one `aria-current="page"`, give each a human label, use Quarantine rather than Brig for the operational destination, and map known job/item/replacement status values through explicit frontend label maps with an unknown-value fallback.
6. Replace all-section polling with active-section loads. Poll jobs and opened details while Jobs is active, retaining a slower idle jobs refresh so automatic recovery can appear; reload other sections only on entry or after their actions.
7. Rename scheduled execution to maintenance, disclose configured quarantine retention, and render `purgedQuarantineCount` when supplied.
8. Apply the shared native-dialog behavior and responsive section-navigation styles from Phase 1. Ensure the mobile footer does not obscure the active settings pane.

### Documentation references

- MDN `aria-current`.
- `src/SettingsDialog.tsx:267-331,375-429,435-637` before implementation.
- `server/settings.mjs:214-340` and `server/index.mjs:165-248`.
- `src/OperationsDialog.tsx:57-61,77-159,178-224` before implementation.
- `server/jobs.mjs:92-137,199-299,331-426,486-774`.
- `server/scheduler.mjs:48-93` and `server/quarantine.mjs:107-118`.

### Verification checklist

- `npm run build` passes after the refactor.
- `npm test` remains green.
- `git diff --check` passes.
- Source inspection proves the original `qbittorrent.recovery` payload shape and one atomic save remain intact.
- Network inspection proves Settings does not remount between sections, Operations requests only active-section data, Jobs can discover automatically created recovery work, and static tabs are not polled every three seconds.
- Browser interaction verifies all five Settings destinations, all Operations destinations, qB category discovery/exclusions, keyboard navigation, Escape/return focus, responsive 390px layout, and no obscured content.

### Anti-pattern guards

- Do not create section-local authoritative form state or per-section saves.
- Do not request saved categories with draft credentials; continue using categories from connection-test responses for draft credentials.
- Do not discard the synthetic empty qBittorrent category.
- Do not stop job refresh permanently when the list is idle.
- Do not expose raw snake-case states as the primary label.
- Do not describe a completed cleanup job as a completed replacement download.

## Phase 3 — Final verification and cleanup

### What to verify

1. Compare the implementation with every Phase 0 allowed API and anti-pattern guard.
2. Run the full test/build/diff suite.
3. Run browser QA at desktop and 390px mobile for dashboard, Settings, Operations, confirmation, loading/empty/filtered-empty states, focus order, Escape, focus return, and horizontal overflow.
4. Record current production JS/CSS output so the refinement does not introduce a material payload regression.
5. Review only the intended UI/audit/plan changes and preserve all pre-existing qBittorrent/backend changes.

### Verification checklist

- `npm test`
- `npm run build`
- `git diff --check`
- No new dependencies.
- No backend route or payload changes caused by the UI refinement.
- No console errors during browser QA.
- No unlabelled mobile connection states, duplicate scan control, partial tab semantics, misleading filtered-clear message, or report-only retention claim.

### Anti-pattern guards

- Do not commit or push; the user did not request either.
- Do not reset or overwrite the dirty worktree.
- Do not broaden the final pass into unrelated backend changes.
