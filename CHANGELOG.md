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
