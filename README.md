# Dream & Memory for DeepSeek Harness

[简体中文](README.zh-CN.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Security](SECURITY.md)

Turn verified DSH conversations into **daily journals, Dream consolidations, weekly reviews, and searchable long-term memory**, without loading whole conversations into every prompt.

## Incremental Dream consolidation

Dream processes up to seven new or modified managed daily journals per run (looking back at most 30 days), including securely archived daily copies. It never rescans the raw transcript as part of routine consolidation. Source-backed candidate extraction and task tracking remain with the daily pipeline; a Dream model output containing fabricated facts or task events is rejected.

Successful complete model batches are cached in derived SQLite for up to seven days; model transport failures can retry once and unfinished work remains eligible for the next run. The model request cancellation budget is 120 seconds and the overall consolidation cancellation budget is eight minutes. No new journals means no model call. Successful daily analysis advances its source cursor even if some candidate facts are rejected; model failure does not advance that cursor.

## Memory lifecycle

1. **Daily journal:** summarize eligible user messages into `memory/YYYY-MM-DD.md`.
2. **Dream:** incrementally consolidate new or updated daily journals into `DREAMS.md` without rescanning raw conversations or fabricating candidate evidence.
3. **Long-term memory:** verify source evidence and publish approved facts to managed sections of `MEMORY.md`.
4. **Recall:** fetch a few relevant published facts from the current authorized workspace; optional embeddings complement keyword search.
5. **Weekly review:** merge the previous week's daily journals, track coverage, and safely archive eligible daily files.

The original native DSH session log remains the evidence source. Candidate memories are not automatically treated as facts, and retrieved user content is not trusted as instructions.

## Semantic recall and historical archives

Automatic recall of **verified, source-backed long-term memory** can use keyword, semantic-fallback, or hybrid matching (`autoRecallMode`). Embedding failures fall back to lexical retrieval; content from unverified history never enters trusted automatic recall.

The single read-only `memory_search` model tool supports `action: 'search'` (default, compatible with existing queries) and `action: 'topics'` (the verified topic index). The plugin maintains a scoped, incremental SQLite index for explicit `memory_search` over curated archives under `memory/history/{daily,weekly,monthly,notes}/`. Only these structured Markdown paths are scanned; account/configuration files and migrated raw sessions are excluded. Rolling daily/weekly maintenance preserves permanent archive copies according to the history settings. No user archives or migration scripts are included in this public package.

CI runs portable memory-indexing and recall tests using `npm test`. The full plugin integration suite (`npm run test:integration`) requires a compatible DSH host with the declared peer services.

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

## Optional plugin diagnostics

The plugin optionally emits privacy-restricted operation and failure metadata to dsh-plugin-diagnostics. Diagnostics contain event type, status, fixed error code and elapsed time; conversation content and credentials are not logged. The diagnostics plugin is optional and does not change the host requirements.

## Natural-language project and task memory

Dream can extract source-backed task events from eligible user messages and link them to stable internal task/project IDs without requiring users to type canonical names. State changes (requested, in progress, blocked, completed, cancelled, reopened) are stored separately from verified long-term facts, with timestamps and verbatim source references. Unclear aliases remain separate rather than being forcibly merged. A status question can receive a dated task timeline via `memory_search` and limited owner-authorized recall; historical user statements are **not evidence of verified implementation**. Manual draft-only runs do not publish events, and revoked/forgotten sources are excluded.

Daily, Dream and weekly consolidation now offer distinct configurable default content-guidance prompts, with a **Restore default** action in the plugin settings. Mandatory JSON, authorization and source verification remain code-enforced. Existing native DSH Session Log remains the evidence source. The task index is populated on new successful memory runs; older journals are still searchable but are not automatically backfilled into structured tasks.

## Optional scheduled-task failure event

After a scheduled memory-maintenance workflow's failure is recorded durably, Dream emits a small `dsh/task-alert` host event with the workflow ID, kind and failed state. Manual runs, successful runs and runs with no new material do not emit an alert. Channel Core, when separately installed and opted in through its task-notification settings, can deliver a brief notification to the verified owner's Feishu or Discord DM. Dream has **no dependency on Channel Core**, and task execution never fails because notifications are unavailable. The event contains no private conversation, memory artifact, or model error detail; notifications are not guaranteed while the host is stopped.
