# Dream & Memory for DeepSeek Harness

[简体中文](README.zh-CN.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Security](SECURITY.md)

Build **daily journals, Dream consolidations, weekly reviews and long-term memory** from authorized DSH conversations. Recall relevant facts without injecting the entire conversation history on every turn.

## Features

- **Daily journals:** Summarize eligible native conversations into `memory/YYYY-MM-DD.md`, with sourced fact candidates and task events.
- **Dream consolidation:** Incrementally merge new or changed journals into `DREAMS.md` without routinely rescanning original transcripts.
- **Weekly review:** Produce weekly summaries and safely archive eligible journals while protecting user edits.
- **Long-term memory:** Verify and review fact candidates before publishing to managed sections of `MEMORY.md`; evidence-checked automatic promotion is optional.
- **Recall and search:** Automatically recall a small set of published facts. `memory_search` supports scoped facts, structured history and topics; embeddings are optional, with lexical fallback.
- **Projects and tasks:** Extract source-backed task timelines from user messages; reported work is not independent proof of implementation.
- **Optional alerts:** Confirmed failures of automatic maintenance can notify verified owner DMs through Channel Core.

## Install and use

```sh
dsh plugin --profile desktop add github:Kerberos255/dsh-memory-dreaming
```

Replace `desktop` with your profile and restart DSH.

1. Open **Settings → Plugins → Dream & Memory** and choose a summarization model.
2. Run daily, Dream and weekly actions manually first; inspect source eligibility and proposed facts.
3. Review candidates. Enable native DSH scheduled jobs or automatic fact promotion only when wanted. **Both are off by default.**
4. Configure automatic recall, structured history and optional embeddings as needed. `memory_dream` creates review-only drafts from an authorized current session.

## Authorization and storage

- Verified owner DMs and **durably bound Feishu/Discord groups and threads** may use published memory from the same workspace; other private DMs stay isolated. **Group members may learn private facts from replies: limit access to trusted groups.**
- Proposed facts are not trusted memory until verified. Unreviewed historical material is not promoted into trusted automatic recall.
- Derived state and indexes use local SQLite. Journals, Dream output and memory remain workspace Markdown, with native DSH sessions as the evidence source.
- Scheduled work uses native DSH Schedule. Portable tests do not prove live model, scheduling or channel behavior.

Tests: `npm test`; host integration: `npm run test:integration`. See [config.example.json](config.example.json), [CHANGELOG.md](CHANGELOG.md) and [LICENSE](LICENSE).
