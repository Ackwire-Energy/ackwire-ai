/*
  Prototype only: reads an Obsidian vault in the browser (a .zip, a folder, or loose .md files)
  and says what would become of it in the wiki. The real import runs on the server.
  Used by Wiki.html and OnboardingV2.html. Needs JSZip on window for .zip files.
*/

const ATTACH = /\.(png|jpe?g|gif|webp|svg|avif|pdf|mp4|mov|webm|mp3|wav|m4a|xlsx?|csv|docx?|pptx?)$/i;
const isMd = (p) => /\.md$/i.test(p);

/** A file in the vault: its path and, for notes, a way to read the text. */
const entry = (path, size, text) => ({ path: path.replace(/\\/g, "/").replace(/^\/+/, ""), size, text });

export async function filesFromZip(file) {
  if (!window.JSZip) throw new Error("JSZip não carregou");
  const zip = await window.JSZip.loadAsync(file);
  const out = [];
  for (const e of Object.values(zip.files)) {
    if (e.dir || e.name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(e.name)) continue;
    out.push(entry(e.name, e._data?.uncompressedSize ?? 0, isMd(e.name) ? () => e.async("string") : null));
  }
  return out;
}

export async function filesFromList(list) {
  const files = [...list];
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) return filesFromZip(files[0]);
  return files
    .filter((f) => f.name !== ".DS_Store")
    .map((f) => entry(f.webkitRelativePath || f.name, f.size, isMd(f.name) ? () => f.text() : null));
}

/** A drop can hold a .zip, files, or whole folders (walked with the entries API). */
export async function filesFromDrop(dt) {
  const items = [...(dt.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!items.length || items.every((e) => e.isFile)) return filesFromList(dt.files);
  const out = [];
  const walk = async (e) => {
    if (e.isFile) {
      const f = await new Promise((ok, no) => e.file(ok, no));
      if (f.name !== ".DS_Store") out.push(entry(e.fullPath, f.size, isMd(f.name) ? () => f.text() : null));
      return;
    }
    const reader = e.createReader();
    for (;;) {
      const batch = await new Promise((ok, no) => reader.readEntries(ok, no));
      if (!batch.length) break;
      for (const c of batch) await walk(c);
    }
  };
  for (const e of items) await walk(e);
  return out;
}

export const looksLikeVault = (dt) => [...(dt?.types ?? [])].includes("Files");

/* ---------- parsing ---------- */

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: { tags: [], aliases: [] }, body: text };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1].toLowerCase();
      const v = kv[2].trim();
      meta[key] = v.startsWith("[") ? v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean) : v ? [v] : [];
      continue;
    }
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li && key) meta[key].push(li[1].trim());
  }
  const clean = (a) => (a ?? []).map((s) => s.replace(/^["']|["']$/g, "").replace(/^#/, "")).filter(Boolean);
  return { meta: { tags: clean(meta.tags ?? meta.tag), aliases: clean(meta.aliases ?? meta.alias) }, body: text.slice(m[0].length) };
}

function parseNote(path, text) {
  const { meta, body } = frontmatter(text);
  const noCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const links = [];
  const embeds = [];
  for (const m of noCode.matchAll(/(!?)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(\|[^\]\n]*)?\]\]/g)) (m[1] ? embeds : links).push(m[2].trim());
  const inline = [...noCode.matchAll(/(?:^|\s)#([\p{L}\d_/-]*[\p{L}_/-][\p{L}\d_/-]*)/gu)].map((m) => m[1]);
  const parts = path.split("/");
  const file = parts.pop();
  return {
    path,
    title: file.replace(/\.md$/i, ""),
    folder: parts.join("/"),
    tags: [...new Set([...meta.tags, ...inline].map((t) => t.toLowerCase()))],
    aliases: meta.aliases,
    links,
    embeds,
    dataview: (body.match(/```dataview/g) ?? []).length,
    callouts: (body.match(/^>\s*\[!/gm) ?? []).length,
    body,
  };
}

/** Drops the vault's own folder ("Acme Vault/…") when every path starts with it. */
function vaultRoot(files) {
  const firsts = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  return firsts.size === 1 && !firsts.has("") ? [...firsts][0] : "";
}

/**
 * What the vault would turn into. `existing` = titles already in the wiki (for conflicts).
 * `onProgress(done, total, path)` is called as notes are read.
 */
export async function readVault(files, { existing = [], onProgress, name } = {}) {
  const root = vaultRoot(files);
  const strip = (p) => (root ? p.slice(root.length + 1) : p);
  const out = { vault: name || root || "vault", notes: [], attachments: [], canvases: [], skipped: { config: 0, trash: 0, other: 0 } };
  const notes = files.filter((f) => isMd(f.path));
  let done = 0;
  for (const f of files) {
    const p = strip(f.path);
    if (/(^|\/)\.obsidian\//.test(p)) { out.skipped.config++; continue; }
    if (/(^|\/)\.trash\//.test(p)) { out.skipped.trash++; continue; }
    if (/(^|\/)\./.test(p)) { out.skipped.other++; continue; }
    if (isMd(p)) {
      out.notes.push(parseNote(p, await f.text()));
      done++;
      if (onProgress && (done % 4 === 0 || done === notes.length)) { onProgress(done, notes.length, p); await new Promise((r) => setTimeout(r, 0)); }
    } else if (/\.canvas$/i.test(p)) out.canvases.push(p);
    else if (ATTACH.test(p)) out.attachments.push({ path: p, size: f.size });
    else out.skipped.other++;
  }

  const lower = (s) => s.toLowerCase();
  const known = new Set([...out.notes.flatMap((n) => [n.title, ...n.aliases]), ...existing].map(lower));
  const files2 = new Set(out.attachments.map((a) => lower(a.path.split("/").pop())));
  const broken = new Set();
  for (const n of out.notes) for (const l of n.links) { const k = lower(l.split("/").pop()); if (!known.has(k) && !files2.has(k)) broken.add(l); }
  const ex = new Set(existing.map(lower));

  const folders = {};
  for (const n of out.notes) { const top = n.folder.split("/")[0] || ""; folders[top] = (folders[top] ?? 0) + 1; }
  out.folders = Object.entries(folders).sort((a, b) => (a[0] === "") - (b[0] === "") || b[1] - a[1]).map(([name, count]) => ({ name, count }));
  out.links = out.notes.reduce((s, n) => s + n.links.length, 0);
  out.embeds = out.notes.reduce((s, n) => s + n.embeds.length, 0);
  out.tags = [...new Set(out.notes.flatMap((n) => n.tags))].sort();
  out.dataview = out.notes.reduce((s, n) => s + n.dataview, 0);
  out.callouts = out.notes.reduce((s, n) => s + n.callouts, 0);
  out.broken = [...broken];
  out.conflicts = out.notes.filter((n) => ex.has(lower(n.title))).map((n) => n.title);
  out.bytes = out.attachments.reduce((s, a) => s + a.size, 0);
  return out;
}

/* ---------- a small vault to try without a file ---------- */

const SAMPLE = {
  "Início.md": `---
tags: [mapa]
aliases: [Home, Começo]
---
# Início

Esta é a vault da Acme. Comece por [[Glossário]] e [[Como trabalhamos]].

## Mapas
- [[Clientes/Mercado Bom|Mercado Bom]], nosso maior cliente
- [[Arquitetura da sincronização]]
- [[Reuniões/2026-10-07 Planejamento Q4|Planejamento do Q4]]

> [!tip] Para quem chegou agora
> Leia [[Onboarding de dev]] antes de abrir o primeiro PR.
`,
  "Glossário.md": `---
tags: [referência]
---
# Glossário

- **SKU**: unidade de estoque. Ver [[Arquitetura da sincronização]].
- **Ruptura**: produto que acabou na gôndola.
- **Giro**: quantas vezes o estoque se renova no mês.
- **PDV**: ponto de venda, o caixa da loja.
`,
  "Como trabalhamos.md": `# Como trabalhamos

Ciclos de duas semanas. Deploy às terças, com aprovação. #processo

- Toda decisão grande vira uma página aqui.
- Reuniões têm pauta em [[Reuniões]] antes de começar.
`,
  "Clientes/Mercado Bom.md": `---
tags: [cliente, varejo]
---
# Mercado Bom

Rede com 42 lojas no interior de SP. Contato: Paula (compras).

## Histórico
- 2025-03: piloto em 3 lojas
- 2025-09: expansão para a rede toda
- Reclamações frequentes: [[Ruptura no fim de semana]]

![[contrato-mercado-bom.pdf]]
`,
  "Clientes/Casa Verde.md": `---
tags: [cliente, varejo]
---
# Casa Verde

Loja de jardinagem, e-commerce + 2 lojas físicas. Usa a [[API pública]].
`,
  "Clientes/Ruptura no fim de semana.md": `# Ruptura no fim de semana

Sábado à tarde as reposições atrasam. Hipótese: a sincronização roda de hora em hora. #incidente

> [!warning] Ainda aberto
> Medir o atraso real antes de mudar o intervalo. Ver [[Arquitetura da sincronização]].
`,
  "Engenharia/Arquitetura da sincronização.md": `---
tags: [engenharia, backend]
---
# Arquitetura da sincronização

Cada loja manda os movimentos do PDV para a fila; um worker consolida o estoque por SKU.

![[diagrama-sync.png]]

## Fila
Postgres com outbox. Sem Redis. Ver [[Banco de dados]].

## Falhas comuns
- Loja offline por horas: reprocessa em lote ao voltar.
- Relógio do PDV errado: usamos a hora do servidor.
`,
  "Engenharia/Banco de dados.md": `# Banco de dados

Postgres 16. Migrations imutáveis. #engenharia

\`\`\`dataview
TABLE file.mtime FROM #engenharia SORT file.mtime DESC
\`\`\`
`,
  "Engenharia/Onboarding de dev.md": `---
tags: [engenharia, onboarding]
---
# Onboarding de dev

1. Peça acesso ao GitHub.
2. Leia [[Arquitetura da sincronização]] e [[Banco de dados]].
3. Pegue uma issue marcada como \`primeira\`.
4. Abra o PR e chame alguém em [[Revisão de código]].
`,
  "Engenharia/API pública.md": `---
tags: [engenharia, api]
aliases: [API]
---
# API pública

REST, com chave por cliente. Limite de 600 requisições por minuto.
`,
  "Reuniões/2026-10-07 Planejamento Q4.md": `---
tags: [reunião]
---
# Planejamento Q4

Presentes: Walter, Ana, Bruno.

- [x] Fechar o escopo da sincronização em tempo real
- [ ] Revisar preços com o [[Mercado Bom]]
- [ ] Contratar mais uma pessoa de suporte
`,
  "Reuniões/2026-10-14 Retro.md": `---
tags: [reunião, retro]
---
# Retro

O que foi bem: deploy sem susto. O que melhorar: [[Ruptura no fim de semana]] demorou para ser visto.
`,
  "Pesquisa/Entrevistas com lojistas.md": `---
tags: [pesquisa]
---
# Entrevistas com lojistas

8 entrevistas em setembro. O que mais aparece: medo de ruptura, planilhas paralelas, pouca confiança no número do sistema.

![[entrevistas.xlsx]]
`,
  "Pesquisa/Concorrentes.md": `# Concorrentes

| Nome | Foco | Preço |
| --- | --- | --- |
| Estoca | grandes redes | alto |
| Prateleira | pequenos | baixo |

Ver também [[Precificação]]. #pesquisa
`,
  "anexos/diagrama-sync.png": 182_000,
  "anexos/contrato-mercado-bom.pdf": 412_000,
  "anexos/entrevistas.xlsx": 64_000,
  "Mapa da vault.canvas": "{}",
  ".obsidian/app.json": "{}",
  ".obsidian/workspace.json": "{}",
  ".obsidian/plugins/dataview/main.js": "",
  ".obsidian/themes/Minimal/theme.css": "",
  ".trash/rascunho antigo.md": "# rascunho",
};

export function sampleVault() {
  return Object.entries(SAMPLE).map(([p, v]) =>
    entry(`Acme Vault/${p}`, typeof v === "number" ? v : v.length, isMd(p) ? async () => v : null),
  );
}

export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1).replace(".", ",")} MB`);
