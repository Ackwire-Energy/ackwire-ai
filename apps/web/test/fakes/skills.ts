/**
 * Test fake — skills (apps/server/src/routes/app/skills.ts), same shapes:
 * - `GET/POST …/skills`, `POST …/skills/import { url } | { url, paths } | { zipBase64 }`,
 *   `GET/PATCH/DELETE …/skills/{id}`, `POST …/skills/{id}/reimport`
 * - `GET/PUT …/agents/{id}/skills` → `{ skills: (Skill & { enabled })[] }`
 * A repository's root holds three skills to pick and one that can't be installed (`{ choices, skipped }`), and `list`
 * lists a folder's one skill. `acme/secret` is private and no connection reaches it; `contoso/skills` is private and the
 * workspace's GitHub connection reads it (`github()`: that connection, none or one GitHub refuses). Scripts are listed
 * as `ignored`.
 */
import { type ApiClient, ApiError, type SkillDetail } from "@agenteschat/client";
import { clone, type MockContext, MockNotFoundError, mockId, perOrg } from "./context";

const CHOICES = [
  { path: "skills/deploy", name: "deploy", description: "Antes de qualquer deploy." },
  { path: "skills/review", name: "review", description: "Revisa um pull request." },
  { path: "skills/triage", name: "triage", description: "Organiza as issues novas." },
];
const SKIPPED = [
  {
    path: "skills/claude-api",
    code: "skill.invalid_description",
    message: "description: 1 to 1024 characters",
    params: { max: 1024 },
  },
];

export function createFakeSkills(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void,
  github: () => "none" | "refused" | "ok" = () => "none",
): ApiClient["skills"] {
  const assigned = new Map<string, Set<string>>();
  const store = perOrg(async (orgId) => {
    const list: SkillDetail[] = [];
    if (!ctx.seed) return list;
    const agents = await ctx.lookup.agents(orgId);
    const now = ctx.now().toISOString();
    const add = (s: Omit<SkillDetail, "id" | "metadata" | "createdAt" | "updatedAt">) => {
      const skill: SkillDetail = { ...s, id: mockId("skill"), metadata: {}, createdAt: now, updatedAt: now };
      list.push(skill);
      return skill.id;
    };
    const review = add({
      name: "Revisão de PR",
      description: "Use quando pedirem para revisar um pull request.",
      version: 3,
      source: "url",
      sourceUrl: "https://github.com/acme/skills/tree/main/pr-review",
      defaultForNewAgents: false,
      body: "# Revisão de PR\n\n1. Leia o diff inteiro.\n2. Rode os testes.\n\n```bash\nbun test\n```",
      files: [
        { path: "SKILL.md", size: 120, mime: "text/markdown", status: "stored" },
        { path: "checklist.md", size: 40, mime: "text/markdown", status: "stored" },
        { path: "scripts/lint.sh", size: 30, mime: "text/x-sh", status: "script" },
        { path: "scripts/old.py", size: 20, mime: "text/x-python", status: "ignored" },
      ],
    });
    add({
      name: "Relatório semanal",
      description: "Monta o resumo da semana.",
      version: 1,
      source: "manual",
      sourceUrl: null,
      defaultForNewAgents: true,
      body: "# Relatório semanal\n\nDecisões, entregas e pendências.",
      files: [{ path: "SKILL.md", size: 60, mime: "text/markdown", status: "stored" }],
    });
    add({
      name: "Atendimento",
      description: "Tom e respostas padrão do suporte.",
      version: 2,
      source: "upload",
      sourceUrl: null,
      defaultForNewAgents: false,
      body: "# Atendimento\n\nSeja breve e cordial.",
      files: [
        { path: "SKILL.md", size: 50, mime: "text/markdown", status: "stored" },
        { path: "respostas.txt", size: 20, mime: "text/plain", status: "stored" },
      ],
    });
    const first = agents[0];
    if (first) assigned.set(first.id, new Set([review]));
    return list;
  });
  const find = async (orgId: string, id: string) => {
    const s = (await store(orgId)).find((x) => x.id === id);
    if (!s) throw new MockNotFoundError("Skill não encontrada.");
    return s;
  };
  const make = async (
    orgId: string,
    s: Omit<SkillDetail, "id" | "metadata" | "createdAt" | "updatedAt" | "version">,
  ) => {
    const at = ctx.now().toISOString();
    const skill: SkillDetail = { ...s, id: mockId("skill"), version: 1, metadata: {}, createdAt: at, updatedAt: at };
    (await store(orgId)).push(skill);
    return clone(skill);
  };
  const forAgent = async (orgId: string, agentId: string) =>
    (await store(orgId)).map(({ body: _b, files: _f, ...s }) => ({
      ...clone(s),
      enabled: assigned.get(agentId)?.has(s.id) ?? false,
    }));
  return {
    list: async (orgId) => (await store(orgId)).map(({ body: _b, files: _f, ...s }) => clone(s)),
    get: async (orgId, id) => clone(await find(orgId, id)),
    create: async (orgId, input) => {
      log("skills.create", orgId, input);
      return make(orgId, {
        name: input.name,
        description: input.description,
        body: input.body,
        source: "manual",
        sourceUrl: null,
        defaultForNewAgents: input.defaultForNewAgents ?? false,
        files: [{ path: "SKILL.md", size: input.body.length, mime: "text/markdown", status: "stored" }],
      });
    },
    import: async (orgId, input) => {
      log("skills.import", orgId, input);
      const url = "url" in input ? input.url : null;
      const hidden = url?.includes("/acme/secret")
        ? "acme/secret"
        : url?.includes("/contoso/") && github() !== "ok"
          ? "contoso/skills"
          : null;
      if (hidden) {
        throw new ApiError(400, "github.repo_missing", `${hidden} is private or doesn't exist on GitHub`, {
          repo: hidden,
          connection: github(),
          app: false,
        });
      }
      const via = url?.includes("/contoso/") ? { via: "github" as const } : {};
      if (url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(url)) {
        return { choices: clone(CHOICES), skipped: clone(SKIPPED), ...via };
      }
      if (url && "list" in input && input.list) return { choices: clone(CHOICES.slice(0, 1)), ...via };
      const name = url ? (url.split("/").filter(Boolean).pop() ?? "skill") : "Skill enviada";
      return make(orgId, {
        name,
        description: url ? "Instalada do GitHub." : "Enviada em .zip.",
        body: `# ${name}`,
        source: url ? "url" : "upload",
        sourceUrl: url,
        ...(via.via ? { sourceVia: via.via } : {}),
        defaultForNewAgents: false,
        files: [{ path: "SKILL.md", size: 10, mime: "text/markdown", status: "stored" }],
      });
    },
    importPicked: async (orgId, url, paths) => {
      log("skills.importPicked", orgId, url, paths);
      const installed: SkillDetail[] = [];
      for (const path of paths) {
        const choice = CHOICES.find((c) => c.path === path);
        if (!choice) throw new MockNotFoundError("Skill não encontrada.");
        installed.push(
          await make(orgId, {
            name: choice.name,
            description: choice.description,
            body: `# ${choice.name}`,
            source: "url",
            sourceUrl: `${url}/tree/HEAD/${path}`,
            ...(url.includes("/contoso/") ? { sourceVia: "github" as const } : {}),
            defaultForNewAgents: false,
            files: [{ path: "SKILL.md", size: 10, mime: "text/markdown", status: "stored" }],
          }),
        );
      }
      return installed;
    },
    update: async (orgId, id, patch) => {
      log("skills.update", orgId, id, patch);
      const s = await find(orgId, id);
      const edits = patch.description !== undefined || patch.body !== undefined;
      Object.assign(s, patch, { updatedAt: ctx.now().toISOString(), version: s.version + (edits ? 1 : 0) });
      return clone(s);
    },
    reimport: async (orgId, id) => {
      log("skills.reimport", orgId, id);
      const s = await find(orgId, id);
      if (s.sourceVia && github() === "none") {
        throw new ApiError(400, "skill.connection_gone", "The GitHub connection that read contoso/skills is gone", {
          repo: "contoso/skills",
        });
      }
      if (s.sourceVia && github() === "refused") {
        throw new ApiError(400, "github.repo_missing", "contoso/skills is private or doesn't exist on GitHub", {
          repo: "contoso/skills",
          connection: "refused",
          app: false,
        });
      }
      s.version += 1;
      return clone(s);
    },
    remove: async (orgId, id) => {
      log("skills.remove", orgId, id);
      const list = await store(orgId);
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list.splice(i, 1);
      for (const set of assigned.values()) set.delete(id);
    },
    forAgent,
    setForAgent: async (orgId, agentId, skills) => {
      log("skills.setForAgent", orgId, agentId, skills);
      assigned.set(agentId, new Set(skills.filter((s) => s.enabled).map((s) => s.skillId)));
      return forAgent(orgId, agentId);
    },
  };
}
