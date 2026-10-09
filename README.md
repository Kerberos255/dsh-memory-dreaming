# Dream & Memory for DeepSeek Harness

[简体中文](README.zh-CN.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Security](SECURITY.md)

Turn verified DSH conversations into **daily journals, Dream consolidations, weekly reviews, and searchable long-term memory**, without loading whole conversations into every prompt.

## Memory lifecycle

1. **Daily journal:** summarize eligible user messages into `memory/YYYY-MM-DD.md`.
2. **Dream:** consolidate recent experiences into `DREAMS.md` and candidate facts.
3. **Long-term memory:** verify source evidence and publish approved facts to managed sections of `MEMORY.md`.
4. **Recall:** fetch a few relevant published facts from the current authorized workspace; optional embeddings complement keyword search.
5. **Weekly review:** merge the previous week's daily journals, track coverage, and safely archive eligible daily files.

The original native DSH session log remains the evidence source. Candidate memories are not automatically treated as facts, and retrieved user content is not trusted as instructions.

## Requirements and install

Requires a DSH host with native session query, scheduling and model services; see [package.json](package.json) for runtime and peer requirements.

```sh
dsh plugin --profile desktop add github:Kerberos255/dsh-memory-dreaming
```

Use your actual profile and restart after installing or updating code.

## Quick start

1. Open **Settings → Plugins → Dream & Memory**. Choose an available summarization model.
2. Start with the manual daily/Dream/weekly actions and inspect eligible-source diagnostics and proposed facts.
3. Review the candidate list and publish verified facts, or deliberately enable automatic promotion with its evidence checks.
4. Enable the built-in DSH scheduled jobs only when wanted; **scheduled processing and automatic fact promotion are off by default**.
5. For private Discord/Feishu sources, configure [Channel Core](https://github.com/Kerberos255/dsh-channel-core) owner verification first.

By default, published facts can be recalled automatically in small bounded amounts. The plugin supports keyword retrieval without an embedding model; an optional embedding provider may improve semantic matching.

## Storage and safety

State and write recovery are managed in local SQLite under DSH data; managed journals, Dream output and `MEMORY.md` remain regular workspace Markdown. Source identity, workspace authorization, incremental cursors, atomic writes, and hash checks protect publication and cleanup. Archived eligible daily entries are retained temporarily before removal; human-edited files are preserved.

An on-demand `memory_dream` tool is **not** permission to inspect unrelated private conversations. Live model and scheduling results must be checked in DSH; standalone CI covers mock-based behavior.

## Development

Run `npm test` for portable tests. Config template: [config.example.json](config.example.json). Historical changes: [CHANGELOG.md](CHANGELOG.md).

Related: [Channel Core](https://github.com/Kerberos255/dsh-channel-core) · [Instruction Files](https://github.com/Kerberos255/dsh-instruction-files) · [Lossless Context](https://github.com/Kerberos255/dsh-lossless-context).

MIT licensed. See [LICENSE](LICENSE).
