# Public source release

This is the standalone source distribution for dsh-memory-dreaming.
Only plugin source and example configuration belong here. Do not commit user
sessions, credentials, databases, or a full DSH installation.

Requires a compatible DeepSeek Harness host providing the peer services from package.json.
The CI runs host-free tests; a passing result does not imply real Discord, Feishu, or browser integration.
The included client code is already generated, so standard installation needs no generator.
Replace <DSH_ROOT> in legacy documentation examples with your DSH install path.
Upstream third-party dependencies retain their own licenses.

Host-dependent integration tests: `trusted-memory`, `lifecycle-incremental`, and `channel-owner-recall` require DSH service packages and configured fixtures; they remain in the source tree, but are excluded from host-free CI.

UI generation: node tools/settings/build.mjs (full rebuild requires matching DSH host packages).

Local-first performance optimization synchronized on 2026-10-08 from DSH plugin source 0.2.2. Changes: fewer repeated SQLite prepares; fresh Channel Core identity bindings are still checked on every recall. Regression tests were run against the local DSH SDK before this public-source sync.
