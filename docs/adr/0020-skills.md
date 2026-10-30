# 0020. Skills in Markdown (SKILL.md), loaded on demand, no code execution

- Status: Accepted. Amended 2026-10-30: Import (a GitHub link is read from the repository's archive, and a link that holds several skills lists them to pick from)
- Date: 2026-10-14

## Decision

**Format.** Skills follow the Agent Skills layout: a `SKILL.md` with YAML frontmatter (`name`: kebab-case, at most 64 characters; `description`: at most 1024; other fields kept as `metadata`) and a Markdown body, plus supporting files. It is plain text, so it works with every model provider.

**Storage.** `skills` (org-scoped, unique `slug` per org, `version`), `skill_files` (per version: path, size, mime, status, blob location) and `agent_skills` (per agent, enabled). File contents go through the org's `BlobStoreResolver` like artifacts. Only text files we can show are stored (md, txt, csv, json, yaml, html, svg). Everything else, scripts first of all, is recorded as `ignored`: listed so people see it, never stored as content and never offered to the model as something to run.

**Import.**
- A zip of the folder: a small zip reader that checks the declared sizes before inflating (2 MB total, 200 files) and rejects path traversal.
- A GitHub URL: a folder through the contents API, or a single `SKILL.md`, raw. Only GitHub hosts, the SSRF guard on every request, no redirects, the same limits; scripts are not even downloaded.
- By hand.

*Amended 2026-10-30:* a GitHub link is read from the repository's zip archive at the link's ref (`github.com/{owner}/{repo}/archive/{ref}.zip`, which redirects to codeload.github.com), no longer through the contents API. Unauthenticated REST API calls share one limit per server address, 60 requests an hour (docs.github.com, "Rate limits for the REST API"), and the contents walk spent one per folder, so every workspace's imports drew on the same budget and one repository of a few dozen skills could spend it. The archive is one download outside the REST API, works with no GitHub connection (a self-host has none by default), and its central directory lists every path, so only the chosen skill's files are inflated. Signing the API calls with the workspace's GitHub connection was the alternative: it helps only workspaces that connected GitHub, spends a person's token on a read the server does for everyone, and still costs a request per folder. This download alone follows redirects, at most 3, each hop to a GitHub host through the SSRF guard. The archive may be up to 50 MB, and one past 65,535 files (whose count only a zip64 record holds) is refused, never read in part. A skill keeps its 2 MB and 200 files, binaries are listed and never inflated, and symbolic links are left out. Each read of a link downloads the archive again, so a person may read 60 links an hour, listing, installing and updating from a link alike (`rate_limited` past that).

A link to a skill's folder installs it as before, and a link to a file, its `SKILL.md` included, installs that file's folder. A link to a repository or to a folder that holds several skills (folders with a `SKILL.md`, up to 6 levels below it, at most 100, one inside another skill's folder being a file of that skill) installs nothing and answers with them, by name and description from each `SKILL.md`, for the person to pick one or several (`POST …/skills/import` with `paths`). A link that holds one skill folder installs it at once. Of several, those that can't be installed (past the 2 MB or the 200 files, or a `SKILL.md` that doesn't parse) come apart in `skipped`, each with its refusal's code (`skill.too_large`, `skill.too_many_files`, `skill.invalid_description`, `skill.invalid_name`…), shown with why and never offered to pick. A skill found below the link records its own folder as its source, so updating it from the link reads that folder only. GitHub's refusals carry codes the apps translate: a private or missing repository (`github.repo_missing`, github.com answers 404), a branch, tag or commit the repository lacks (`github.ref_missing`, codeload answers 404 after the redirect), GitHub limiting the server (`github.limited`, a 429 with the minutes to wait from `retry-after` or `x-ratelimit-reset`, else one), and no `SKILL.md` at or below the link (`skill.no_skill_md`).

Importing a skill whose name already exists in the org makes a new version; re-import from the source URL does the same. Install, update, delete and per-agent changes are audited.

**Runtime: progressive disclosure.** The prompt lists only the agent's enabled skills (name and description) under "Skills disponíveis", with the rule to load a matching skill before acting. `load_skill(name)` returns the body and the file list; `read_skill_file(name, path)` returns a text file, truncated. Both are built-in tools with scope `skills:read`, granted by default (backfilled by migration 0024) and deniable through per-agent access. Loads are tool steps, so they show in "Ações recentes", and the tokens are counted by the Model Gateway like everything else.

## Consequences

- Skills can't do anything a prompt can't: no new permission path, and no code runs until the sandbox phase decides how scripts may execute.
- Anthropic's native skills (through their API) are left for later.
