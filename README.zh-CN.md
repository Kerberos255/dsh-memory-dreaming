# DSH Dream 与长期记忆

[English](README.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [安全说明](SECURITY.md)

从**有权限访问的真实 DSH 会话**提取每日记录、Dream、周记和长期事实；新会话按需召回少量相关记忆，而不是每轮读取全部聊天历史。

## 三种整理与长期记忆的区别

| 类型 | 做什么 | 输出 |
| --- | --- | --- |
| 每日记忆 | 整理目标日期的合规用户消息 | `memory/YYYY-MM-DD.md` |
| Dream | 从一段时间的经验提炼主题、候选事实 | `DREAMS.md` 与待核验候选 |
| 每周复查 | 汇总上一周的每日记忆、核对日期覆盖并归档旧日记 | `memory/weekly/` |
| 长期记忆 | 来源验证、候选审阅或按规则自动晋升 | `MEMORY.md` 受管区 |
| 自动召回 | 针对当前问题检索少量已发布事实 | 当前会话的参考上下文 |

候选事实不等于已确认事实。原始 DSH Session Log 始终是出处真源，日记摘要不能冒充原始用户证据。

## 安装与兼容性

具体 DSH/Node/peer 依赖见 [package.json](package.json)。

```sh
dsh plugin --profile desktop add github:Kerberos255/dsh-memory-dreaming
```

请按实际 Profile 替换名称；安装或更新插件代码后重新打开 DSH。

## 快速开始

1. 打开「设置 → 插件 → Dream 与长期记忆」，选择 DSH 已配置的整理模型。
2. 先使用「整理今日记忆」「Dream 整理」「复查本周」手动运行，检查会话/消息范围与来源诊断。
3. 在候选区查看原始出处，手工确认长期事实；如希望无人值守，再开启符合条件的自动晋升。
4. 根据需求开启 DSH 原生计划任务。**自动计划和自动晋升默认关闭**，不会自行启动。
5. 希望从 Discord/飞书私聊学习或召回时，先在 Channel Core 核验主人身份和工作区边界。

## 工作区、检索和分批处理

- 同一工作区下的合规 Session 可跨 Agent 预设处理，但普通子代理、工具文本、未认证的渠道消息不作为私人记忆来源。
- 每日按配置时区的目标日期、每周按指定日历周、Dream 按回顾窗口筛选；会话多时按模型预算分批处理，完整成功才提交处理游标。
- 模型截断会拆批或有界重试；失败保留既有内容并提供诊断，不伪称成功。
- 已发布事实支持关键词检索，Embeddings 可选；没有可用向量模型时仍能使用词语检索。
- 召回按当前会话的权限和问题选择少量相关事实，不把全部 `MEMORY.md` 或原始会话复制进提示词。

## 数据安全和清理

SQLite 保存任务、来源游标、候选和写入恢复状态；Markdown 是工作区实际记忆文件。每日归档仅在完成周记和哈希校验后移动合规日记，过了保护期才清理；人工改动会阻止自动覆盖与删除。真实模型/计划任务仍需在宿主环境验收。

配置：[config.example.json](config.example.json) · 测试：`npm test` · [变更记录](CHANGELOG.md) · [安全说明](SECURITY.md)。

相关：[Channel Core](https://github.com/Kerberos255/dsh-channel-core) · [指令文件与角色](https://github.com/Kerberos255/dsh-instruction-files) · [无损上下文](https://github.com/Kerberos255/dsh-lossless-context)。

许可证：[MIT](LICENSE)。
