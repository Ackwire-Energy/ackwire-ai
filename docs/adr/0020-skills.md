# 0020. Skills in Markdown (SKILL.md), loaded on demand, no code execution

- Status: Accepted
- Date: 2026-10-14

## Decision

**Format.** Skills follow the Agent Skills layout: a `SKILL.md` with YAML frontmatter (`name`: kebab-case, at most 64 characters; `description`: at most 1024; other fields kept as `metadata`) and a Markdown body, plus supporting files. It is plain text, so it works with every model provider.

**Storage.** `skills` (org-scoped, unique `slug` per org, `version`), `skill_files` (per version: path, size, mime, status, blob location) and `agent_skills` (per agent, enabled). File contents go through the org's `BlobStoreResolver` like artifacts. Only text files we can show are stored (md, txt, csv, json, yaml, html, svg). Everything else, scripts first of all, is recorded as `ignored`: listed so people see it, never stored as content and never offered to the model as something to run.

**Import.**
- A zip of the folder: a small zip reader that checks the declared sizes before inflating (2 MB total, 200 files) and rejects path traversal.
- A GitHub URL: a folder through the contents API, or a single `SKILL.md`, raw. Only GitHub hosts, the SSRF guard on every request, no redirects, the same limits; scripts are not even downloaded.
- By hand.

Importing a skill whose name already exists in the org makes a new version; re-import from the source URL does the same. Install, update, delete and per-agent changes are audited.

**Runtime: progressive disclosure.** The prompt lists only the agent's enabled skills (name and description) under "Skills disponíveis", with the rule to load a matching skill before acting. `load_skill(name)` returns the body and the file list; `read_skill_file(name, path)` returns a text file, truncated. Both are built-in tools with scope `skills:read`, granted by default (backfilled by migration 0024) and deniable through per-agent access. Loads are tool steps, so they show in "Ações recentes", and the tokens are counted by the Model Gateway like everything else.

## Consequences

- Skills can't do anything a prompt can't: no new permission path, and no code runs until the sandbox phase decides how scripts may execute.
- Anthropic's native skills (through their API) are left for later.
