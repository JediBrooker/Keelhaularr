# Evidence

## Method

The audit combined source inspection, an isolated production build, desktop and mobile browser captures, computed-style measurements, a complete user-facing-copy inventory, and accessibility/interaction analysis. No product source was changed during evidence collection.

Primary sources:

- `src/App.tsx:87-188,190-516`
- `src/SettingsDialog.tsx:247-715`
- `src/OperationsDialog.tsx:63-224`
- `src/DirectoryInput.tsx:25-157`
- `src/styles.css:1-31`
- `src/DirectoryInput.css:1-19`
- `server/exclusions.mjs:9-13`
- `server/jobs.mjs:486-629`
- `server/qbittorrent-recovery.mjs:70-239`
- `server/scheduler.mjs:48-93`
- `server/quarantine.mjs:107-118`

Rendered evidence:

- Desktop dashboard at 1440×1000
- Mobile dashboard at 390×844
- Desktop and mobile Settings
- Desktop and mobile Operations
- Production output generated with Vite into an isolated `/tmp` directory

## Structural facts

- The audited source contains 86 authored interactive-control templates: 24 in `App.tsx`, 48 in `SettingsDialog.tsx`, 10 in `OperationsDialog.tsx`, and 4 in `DirectoryInput.tsx`. Runtime rows produced by a single map template were counted once.
- The deepest component path is five boundaries: `App → SettingsDialog → ConnectionSection → FolderList → DirectoryInput`.
- Eight repeated-purpose affordance groups were found. The most visible duplication is scan initiation in the hero and empty state (`App.tsx:433-436,476`) and Settings dismissal in both header and footer (`SettingsDialog.tsx:644,708`).
- TypeScript's unused-local/unused-parameter checks reported no unused imports or dead props.
- The empty dashboard exposes 17 authored controls; its enabled keyboard sequence contains 13 stops before the second scan action.
- Settings renders seven top-level content sections/components in one continuous scroll (`SettingsDialog.tsx:651-704`).

## Visual and responsive facts

- Desktop document height was 1,560px. Mobile document height was 2,783px.
- On mobile, the first viewport reaches only the start of the first summary card. The hero occupies approximately y=244–670, and summary content starts around y=704.
- The current surface uses three font families, 16 rendered font sizes, 30 observed spacing values, 128 exact color literals across the two CSS files, and 32 rendered non-transparent computed colors in the inspected state.
- The layout did not produce body-level horizontal overflow at 375px content width. Operations intentionally uses a horizontal tab scroller for five destinations.
- Mobile connection pills hide their text with `font-size: 0`, leaving only two visually unlabeled dots (`styles.css:26`).
- Empty, loading, error, success, focus, disabled, and reduced-motion states are all represented. Focus styling is not consistent across ordinary buttons, tabs, and close controls.

## Copy and behavioral truth

- Nautical language gives the product a distinctive voice, but it is also used for operational controls: “Keelhaul,” “Orphan watch,” “Both holds,” “Brig,” “Purge,” and “settled.” Literal alternatives are more direct for actions while the metaphor can remain in brand and decorative copy.
- `ConnectionPill` displays “Ready” when an app is merely configured, without a live connection result (`App.tsx:149-152`). “Configured” is the behaviorally accurate state.
- “All clear in this hold” is shown whenever the filtered `visible` list is empty, including when search or filters hide findings (`App.tsx:231-246,478`). The filtered state should say “No matching files”; “All clear” should be reserved for a truly empty source.
- “No permanent exclusions” conflicts with the reversible “Include again” action and with exclusion behavior (`OperationsDialog.tsx:217`, `server/exclusions.mjs:9-13`).
- “Run report now” and “Reports never delete findings” omit that the same scheduler run applies configured quarantine retention (`OperationsDialog.tsx:219`, `server/scheduler.mjs:48-93`, `server/quarantine.mjs:107-118`). The UI should name this maintenance side effect and surface `purgedQuarantineCount` when present.
- Destructive confirmation is neutral and explicit: CANCEL/CONFIRM, permanent deletion says it cannot be undone, and qBittorrent recovery is labelled destructive and opt-in.

## Accessibility facts

- Primary contrast passes include ink/paper 14.24:1, muted/paper 4.69:1, white/teal 9.23:1, success 6.36:1, error 6.58:1, and warning 5.62:1.
- Normal-text contrast failures include eyebrow 4.36:1, gold eyebrow 4.23:1, white/coral danger controls 3.74:1, field hints 3.24:1, path text 3.28:1, table headings 4.12:1, header text buttons 4.34:1, and the modal close control 4.03:1.
- Primary actions use native controls and are keyboard reachable. DirectoryInput has complete combobox/listbox semantics and explicit Arrow, Enter, Escape, and Tab handling.
- The manifest has a `tablist` but its buttons lack `role="tab"`, `aria-selected`, and `aria-controls` (`App.tsx:459-463`). Operations indicates the current destination only with CSS (`OperationsDialog.tsx:185-186`).
- Dialogs do not move focus on open, trap focus, handle Escape, make the background inert, or restore focus. The confirmation alone uses `autoFocus` on CANCEL.
- There is no skip link. Compact tabs and header controls commonly render at roughly 27–38px high; mobile rules do not increase those targets.

## Runtime weight and attention cost

- Initial JavaScript: 253,711 bytes raw / 74,698 bytes gzip.
- Initial CSS: 28,431 bytes raw / 6,487 bytes gzip.
- Combined initial JS and CSS: 282,142 bytes raw / 81,185 bytes gzip.
- The modelled configured-dashboard load is 10 requests: HTML, one JS chunk, one CSS file, two sequential API calls, one Google Fonts stylesheet, and four Latin WOFF2 resources. The estimate excludes favicon and cache variation.
- The local lower-bound TTI estimate is 25.5ms; this is not a browser trace and excludes real network, layout, and paint variability.
- The configured idle dashboard has zero animations and no recurring polling.
- Operations immediately loads four resources and repeats those four base requests plus every previously opened job detail every three seconds while the dialog remains open (`OperationsDialog.tsx:117-145`).
- Settings and Operations are included in the single initial JS chunk even before either dialog is opened.

## Principle traceability

1. **Innovative** — product-specific nautical identity; integrated Radarr/Sonarr/qBittorrent recovery; otherwise established card, table, form, tab, and dialog patterns.
2. **Useful** — scan, filter, batch, remove, quarantine, restore, retry, health, scheduling, and configuration tasks are all reachable; duplication and long forms add friction.
3. **Aesthetic** — coherent typography and palette with polished desktop alignment; token, spacing, and decorative variation is higher than necessary.
4. **Understandable** — descriptive headings and safety text coexist with metaphorical actions, inaccurate state labels, and incomplete tab semantics.
5. **Unobtrusive** — the configured initial dashboard has no notice, animation, or modal; the large hero delays working content, particularly on mobile.
6. **Honest** — destructive behavior is generally disclosed; configured-vs-connected, filtered empty states, and scheduler retention need more accurate labels.
7. **Long-lasting** — native HTML and a restrained dependency set support durability; core visual language is brand-specific rather than trend-dependent.
8. **Thorough** — broad empty/loading/error/success/reduced-motion coverage; dialog focus, consistent focus indicators, contrast, and tab semantics remain incomplete.
9. **Environmentally friendly** — small gzip payload and zero idle animation; external fonts and aggressive Operations polling add avoidable requests.
10. **As little design as possible** — repeated scan and policy surfaces, seven continuous Settings sections, and 86 control templates show clear consolidation opportunities.

## Known gaps

- The isolated fixture contained no real Arr/qBittorrent data, populated manifest, jobs, or discovered categories.
- TTI and initial request count are explicitly modelled rather than captured from a browser performance trace.
- A second live keyboard pass could not reconnect to the in-app browser; dialog conclusions are based on exact source behavior and the earlier accessibility tree.
- No screen reader, forced-colors, browser zoom, dark-mode, or peer-product comparison was performed.
