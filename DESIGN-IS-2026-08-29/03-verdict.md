# Verdict: REFINE

The score is **20/30**, and no principle scored 0. Under the audit's mechanical decision rule, the outcome is **REFINE**.

The underlying product model is sound: the interface exposes the right jobs, preserves safety gates, covers operational states, and has a recognizable identity. The work should therefore preserve the current architecture and visual character while reducing the distance between opening the app and acting on files.

## Refinement priorities

1. **Shorten the dashboard path to work.** Compress the hero, keep one scan entry point, remove the duplicate standing-orders panel, and hide result-only controls until scan data exists.
2. **Give Settings an information architecture.** Add section navigation and render one focused settings group at a time while retaining all form state and the existing single-save behavior.
3. **Use literal operational language.** Keep nautical flavor in brand/eyebrow text, but rename actions and system states to what they do.
4. **Make states truthful.** Distinguish configured from connected, filtered-empty from truly clear, and disclose that scheduled/manual maintenance can apply quarantine retention.
5. **Complete interaction semantics.** Add dialog focus management and Escape behavior, full tab/current-state semantics, visible focus treatment, adequate contrast, and better mobile targets.
6. **Reduce passive work.** Poll only the active Operations data that needs freshness and avoid refetching static tabs and already loaded details every three seconds.

## Preserve

- Parchment, deep teal, gold, and coral identity
- Fraunces-led display character, used more selectively
- Server-side revalidation and neutral CONFIRM/CANCEL flow
- Current backend endpoints and qBittorrent recovery safety behavior
- Responsive no-overflow behavior and reduced-motion support
