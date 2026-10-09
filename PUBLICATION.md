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

## 0.2.18 · 2026-10-09

- 原生 Schedule 的维护 Session 被归档或确实丢失时，安全创建新的维护 Session 接棒；只有确认旧任务已停用才重建三条任务，保留历史账本。单独删除某条任务不自动恢复。
- 每日自动任务建议设在次日 00:15，整理前一日；周一 04:30 汇总上周一至周日的受管日记，发布 `memory/weekly/YYYY-MM-DD_YYYY-MM-DD.md`。既有用户配置不会被升级强行改写，需在设置页确认时间。
- 日记先留 14 天受管备份；周报提交后才创建归档日志、校验并移动日记，异常与重启可以恢复；人工修改与来源缺失阻止删除。长期候选仍基于原始 Session 校验，不采信合成周记作为原文证据。
- 公开 CI 使用合成工作区、Node SQLite 和独立 Session mocks；不上传本机 `E:` 路径下的真实会话、凭证或压测 fixture。Dream 的模型截断自适应预算、分批、候选核验仍依赖宿主集成测试。
