# DSH Dream 与长期记忆

[English](README.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [安全说明](SECURITY.md)

从有权限访问的 DSH 会话整理**每日记忆、Dream、周记和长期事实**，按需召回相关内容，不必把整份历史塞进每轮提示词。

## 主要功能

- **每日记忆**：根据可核验的原始会话生成 `memory/YYYY-MM-DD.md`，提取候选事实与任务状态。
- **Dream 整理**：增量合并新增或改变的日记到 `DREAMS.md`，不会在日常巩固时重新扫描全部会话原文。
- **每周复查**：合并周记并安全归档旧日记；人工修改的文件受到保护。
- **长期记忆**：核对来源后将已审阅事实写入 `MEMORY.md`；可选开启有证据约束的自动晋升。
- **记忆检索**：自动召回少量已发布事实，`memory_search` 可检索已授权的事实、结构化历史与主题；关键词检索不依赖向量模型，语义检索为可选增强。
- **项目与任务**：从用户消息提取带出处的项目、任务与状态时间线；历史陈述不等于实际代码或部署已验证。
- **可选通知**：自动维护任务首次确认失败后，可与 Channel Core 配合通知已核验的主人私聊。

## 安装与使用

```sh
dsh plugin --profile desktop add github:Kerberos255/dsh-memory-dreaming
```

将 `desktop` 换成实际 Profile，安装后重启 DSH。

1. 打开 **设置 → 插件 → Dream 与长期记忆**，选择用于整理的模型。
2. 先手动运行每日整理、Dream 和每周复查，确认来源、候选事实及输出。
3. 审阅长期记忆候选；需要无人值守时，再开启 DSH 原生定时任务或自动晋升。**这两项默认关闭。**
4. 按需配置自动召回、历史检索和向量模型。`memory_dream` 可从当前有权限的会话生成待审草稿。

## 权限与数据

- 已核验的主人私聊及 Channel Core **持久绑定的飞书/Discord 群聊、帖子**可使用同工作区记忆；其他人的私聊隔离。**群成员可能从机器人回复中获取私人事实，请严格控制群聊准入。**
- 候选事实不会在未经验证时成为可信长期记忆；未审核历史不会自动提升为已确认事实。
- 状态与来源索引在本地 SQLite；日记、Dream 和长期记忆是工作区 Markdown，原始 Session 仍由 DSH 管理。
- 自动任务由 DSH 原生 Schedule 执行。独立测试不能代替真实模型、定时任务与渠道验证。

测试：`npm test`；宿主集成：`npm run test:integration`。配置见 [config.example.json](config.example.json)，历史见 [CHANGELOG.md](CHANGELOG.md)，许可见 [LICENSE](LICENSE)。
