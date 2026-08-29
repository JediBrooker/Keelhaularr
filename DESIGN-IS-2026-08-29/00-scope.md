# Keelhaularr interface refinement audit — scope

## Audited surface

- Repository: `/Users/cbrooker/Code/keelhaularr`
- Authenticated application shell in `src/App.tsx`
- Dashboard summary, scan controls, manifest filters/table, empty/error/working states, and confirmation dialog
- Settings dialog in `src/SettingsDialog.tsx`
- Operations dialog in `src/OperationsDialog.tsx`
- Shared visual system and responsive rules in `src/styles.css`
- Desktop and mobile renderings of the local Vite application

## Primary user and task

The primary user is a self-hosting administrator who operates Radarr, Sonarr, and qBittorrent. Their primary task is to understand system state quickly, scan for cleanup candidates, safely act on findings, and configure automation without losing confidence about what will be deleted or retried.

## Constraints

- Preserve Keelhaularr's restrained nautical identity and existing plain-language safety tone.
- Keep React, TypeScript, and Vite; add no UI framework or runtime dependency.
- Preserve all server behavior, safety checks, and current uncommitted feature work.
- Improve information hierarchy, density, navigation, and responsive efficiency rather than redesigning the product from scratch unless the evidence requires it.
- Retain keyboard accessibility, visible focus, reduced-motion behavior, explicit destructive confirmations, and desktop/mobile support.

## References

No competitor or replacement design was supplied. The shipped local interface is the source of truth; the requested outcome is a cleaner, more efficient, streamlined refinement.
