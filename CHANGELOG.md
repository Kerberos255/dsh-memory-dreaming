## 0.2.35

- Keep `DREAMS.md` bounded: managed Dream blocks older than `dreamRetentionDays` (default 30 days, 0 keeps everything) move to `memory/history/dreams/<YYYY-MM>.md` right after the day's block is committed. The archive is written before the block is removed, so a crash can duplicate a block but never lose it, and text outside the managed markers is never touched.

# Changelog · Dream & Memory

Historical updates previously mixed into README are collected here. Current behavior and installation: [English](README.md) / [简体中文](README.zh-CN.md).

- **Source diagnostics:** distinguishes wrong day, unsupported event types, untrusted channels, and already-processed messages when no new input is eligible.
- **Workspace-wide batching:** traverses eligible sessions across presets and nested workspaces; splits work into bounded model calls and commits only complete results.
- **Model error classification:** provides safe structured reasons for truncation, rate limiting, quota, authentication, and network/provider failures.
- **Native manual dispatch:** uses DSH's session controller and cancellation signal for manual memory maintenance.
- **Adaptive model output:** retries bounded single-source truncation without publishing partial JSON.
- **Archived maintenance-session recovery:** creates a fresh native maintenance session when its prior session is genuinely archived and tasks have ended.
- **Weekly journal lifecycle:** verifies coverage, commits a weekly report, archives eligible daily files by hash and prunes verified temporary files after the retention window.
- **Cross-session recall:** retrieves only verified published facts scoped to the current workspace and authorized owner.

See Git history for release-specific commits; passing host-free tests is not proof of live-model quality or external channel delivery.

## 0.2.27 (2026-10-13)

- Add automatic semantic memory recall with lexical fallback and explicit-only historical full-text search.
- Preserve rolling daily/weekly archives in source-independent historical directories.

## Unreleased · project/task memory and editable prompts

- Add source-backed natural-language task/project identity, dated state transitions, cautious status retrieval, independent daily/Dream/weekly prompts, and editable defaults.

## 0.2.28 (2026-10-16)

- Emit an optional host event after a scheduled Dream workflow's first persisted failure. No Channel Core dependency, model output, memory text, or task-result mutation.
