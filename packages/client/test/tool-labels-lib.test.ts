import { describe, expect, test } from "bun:test";
import { en as enStrings, resources, STRINGS } from "@agenteschat/i18n";
import { type AppLocale, LOCALE_CODES, localeInfo } from "@agenteschat/i18n/locale";
import { checkLocale } from "@agenteschat/i18n/testing";
import i18next, { type TFunction } from "i18next";
import identical from "../../i18n/test/identical.json";
import type { Approval } from "../src/index";
import {
  actionName,
  approvalDetail,
  approvalRuleWords,
  approvalTitle,
  approveAlwaysWords,
} from "../src/lib/approval-words";
import { catalogLabel, labelIsName, toolKey } from "../src/lib/tool-labels";
import { partsOf, toolName } from "../src/lib/tool-review";
import { stepLabel, toolLineHint } from "../src/lib/work";

const tOf = (lng: string): TFunction => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
  return instance.t;
};
const pt = tOf("pt-BR");
const en = tOf("en");
const es = tOf("es");

/** The catalog: a tool's own name → its words, in each language's strings. */
const labelsOf = (code: AppLocale) => (STRINGS[code].toolNames as { label: Record<string, string> }).label;
const KEYS = Object.keys(enStrings.toolNames.label);

const approval = (over: Partial<Approval>): Approval =>
  ({
    tool: "merge_pull_request",
    scope: "github:pr.merge",
    title: "Merge PR #42 into main",
    detail: "",
    params: {},
    email: null,
    connector: null,
    ...over,
  }) as Approval;

describe("the catalog of tool names", () => {
  test("every key is a name as written once its app is off; every label a verb phrase in plain copy", () => {
    const bad = KEYS.filter((key) => toolKey(key).key !== key).map((key) => `${key}: key reads as ${toolKey(key).key}`);
    for (const code of LOCALE_CODES) {
      // Chinese, Japanese and Korean have no capitals.
      const cased = localeInfo(code).script !== "cjk";
      for (const [key, label] of Object.entries(labelsOf(code))) {
        if (cased && !/^\p{Lu}/u.test(label)) bad.push(`${code} ${key}: "${label}" starts in lower case`);
        if (/[;"“”«»]|[.。]$/.test(label))
          bad.push(`${code} ${key}: "${label}" has a semicolon, a quote or a full stop`);
        if (/_/.test(label)) bad.push(`${code} ${key}: "${label}" reads like code`);
      }
    }
    expect(bad).toEqual([]);
    expect(KEYS.length).toBeGreaterThan(400);
  });

  test("every language has its own words for every tool, the same as English only where listed", () => {
    const source = { toolNames: { label: labelsOf("en") } };
    const same: Record<string, string[]> = identical.app;
    for (const code of LOCALE_CODES) {
      const labels = labelsOf(code);
      const t = tOf(code);
      // Missing, empty, left in English, a glossary name reworded: the strings' own check, on the catalog alone.
      const target = { toolNames: { label: labels } };
      const problems = code === "en" ? [] : checkLocale({ source, target, code, ready: true, identical: same[code] });
      // What the screens get: the lookup itself, for every key.
      const unread = KEYS.filter((key) => !labels[key] || catalogLabel(t, key) !== labels[key]);
      expect({ code, problems, unread }).toEqual({ code, problems: [], unread: [] });
    }
  });

  test("found however the server writes the name, without its app, account or articles", () => {
    const cases: [string, string, string][] = [
      ["github.merge_pull_request", "Merge a pull request", "Fazer merge de um PR"],
      ["github_merge_pull_request", "Merge a pull request", "Fazer merge de um PR"],
      ["GITHUB_CREATE_AN_ISSUE", "Create issue", "Criar issue"],
      ["mcp__higgsfield__generate_image", "Generate image", "Gerar imagem"],
      ["higgsfield-generate-image", "Generate image", "Gerar imagem"],
      ["ONE_DRIVE_ONEDRIVE_LIST_ITEMS", "List files", "Listar arquivos"],
      ["MICROSOFT_TEAMS_TEAMS_LIST", "List teams", "Listar equipes"],
      ["stripe_2_list_customers", "List customers", "Listar clientes"],
      ["getJiraIssue", "See Jira issue", "Ver issue do Jira"],
      ["SLACK_SEND_MESSAGE", "Send message", "Enviar mensagem"],
      ["browser_click", "Click on the page", "Clicar na página"],
    ];
    for (const [name, english, portuguese] of cases) {
      expect({ name, en: catalogLabel(en, name), pt: catalogLabel(pt, name) }).toEqual({
        name,
        en: english,
        pt: portuguese,
      });
    }
    expect(toolKey("GITHUB_CREATE_AN_ISSUE")).toEqual({ app: "GitHub", key: "create_issue" });
    expect(catalogLabel(pt, "frobnicate_widget")).toBeNull();
  });

  test("each language's own words through the lookup, however the name is written", () => {
    const cases: [AppLocale, string, string, string][] = [
      ["es", "Hacer merge de un pull request", "Crear repositorio", "Enviar mensaje"],
      ["fr", "Fusionner une pull request", "Créer un dépôt", "Envoyer un message"],
      ["de", "Pull Request mergen", "Repository erstellen", "Nachricht senden"],
      ["it", "Unisci una pull request", "Crea repository", "Invia messaggio"],
      ["nl", "Pull request mergen", "Repository maken", "Bericht sturen"],
      ["ja", "プルリクエストをマージ", "リポジトリを作成", "メッセージを送信"],
      ["ko", "풀 리퀘스트 병합", "저장소 생성", "메시지 보내기"],
      ["zh-Hans", "合并 PR", "创建仓库", "发送消息"],
      ["id", "Merge pull request", "Buat repositori", "Kirim pesan"],
      ["tr", "Pull request'i birleştir", "Depo oluştur", "Mesaj gönder"],
      ["pl", "Scal pull request", "Utwórz repozytorium", "Wyślij wiadomość"],
      ["ru", "Объединить pull request", "Создать репозиторий", "Отправить сообщение"],
    ];
    for (const [code, merge, create, send] of cases) {
      const t = tOf(code);
      expect({
        code,
        merge: catalogLabel(t, "github.merge_pull_request"),
        create: toolName(t, partsOf("create_repository"), "create_repository"),
        send: toolName(t, partsOf("SLACK_SEND_MESSAGE"), "SLACK_SEND_MESSAGE"),
      }).toEqual({ code, merge, create, send });
    }
  });

  test("a tool the catalog has no words for gets a name built from the language's own verbs and nouns", () => {
    expect(catalogLabel(es, "list_widgets")).toBeNull();
    expect(toolName(es, partsOf("list_widgets"), "list_widgets")).toBe(`${es("toolNames.verb.list")} widgets`);
    expect(es("toolNames.verb.list")).not.toBe("List");
    // A name that is also a property of every object finds no words, and reads as itself.
    expect(catalogLabel(en, "constructor")).toBeNull();
    expect(catalogLabel(en, "…")).toBeNull();
    expect(toolName(en, partsOf("constructor"), "constructor")).toBe("Constructor");
  });

  test("inside a sentence the words keep the language's capitals: German nouns, the Turkish dotted i", () => {
    const step = (tool: string) => ({ kind: "usingTool" as const, tool });
    expect(stepLabel(en, step("git_clone"), "en")).toBe("Used the clone repository tool");
    expect(stepLabel(tOf("de"), step("git_clone"), "de")).toBe("Das Tool Repository klonen genutzt");
    expect(stepLabel(tOf("tr"), step("add_comment_to_pending_review"), "tr")).toBe(
      "incelemeye yorum ekle aracını kullandı",
    );
  });

  test("a name the catalog doesn't know reads as words, its verb in the language, without the app beside it", () => {
    expect(toolName(pt, partsOf("frobnicate_widget"), "frobnicate_widget")).toBe("Frobnicate widget");
    expect(toolName(pt, partsOf("higgsfield.magic_tool"), "higgsfield.magic_tool")).toBe("Magic tool");
    expect(toolName(pt, partsOf("list_widgets"), "list_widgets")).toBe("Listar widgets");
  });
});

describe("tool names where people see them", () => {
  test("an approval card: a risky kind keeps its own words, and the line under it drops the code name", () => {
    const merge = approval({ detail: "github.merge_pull_request · agentes-chat/app · PR 42" });
    expect(approvalTitle(pt, merge)).toBe("Fazer um merge");
    expect(approvalDetail(merge, "pt-BR")).toBe("agentes-chat/app · PR 42");
    expect(approvalTitle(pt, approval({ params: { owner: "agentes-chat", repo: "app", pullNumber: 42 } }))).toBe(
      "Fazer merge do PR #42 em agentes-chat/app",
    );
    // A call kept after its connection went: its values in words, never `key=value`.
    const raw = approval({
      detail: "github.merge_pull_request · owner=acme · pullNumber=7",
      params: { owner: "acme", pullNumber: 7 },
    });
    expect(approvalDetail(raw, "pt-BR")).toBe("Owner: acme · Pull number: 7");
    // Anything else keeps its own detail (code, a text).
    expect(approvalDetail(approval({ tool: "run_code", detail: "print(1) · 2" }), "pt-BR")).toBe("print(1) · 2");
  });

  test("GitHub's newer tools in words; a repository's deletion says which repository", () => {
    const deletion = approval({
      tool: "github_delete_repository",
      scope: "github:repo.admin",
      title: "Delete acme/old",
      connector: "github",
      params: { owner: "acme", repo: "old" },
    });
    expect(approvalTitle(pt, deletion)).toBe("Apagar o repositório acme/old");
    expect(approvalTitle(en, deletion)).toBe("Delete the repository acme/old");
    expect(catalogLabel(pt, "github_discussion_comment_write")).toBe("Comentar numa discussão");
    expect(catalogLabel(en, "github_get_secret_scanning_alert")).toBe("See leaked secret alert");
    const name = "list_repository_security_advisories";
    expect(toolName(es, partsOf(name), name)).toBe("Listar los avisos de seguridad de un repositorio");
    expect(toolName(es, partsOf("get_dependabot_alert"), "get_dependabot_alert")).toBe("Ver alerta de dependencia");
  });

  test("a custom server's tool: worded unless someone named it on the review", () => {
    const image = approval({
      tool: "higgsfield_generate_image",
      scope: "custom:c1:approval",
      title: "Higgsfield: Generate image",
      connector: "custom:c1",
      params: { prompt: "capa" },
    });
    expect(approvalTitle(pt, image)).toBe("Gerar imagem");
    expect(approvalTitle(pt, { ...image, title: "Higgsfield: Gerar capa do episódio" })).toBe(
      "Higgsfield: Gerar capa do episódio",
    );
    expect(labelIsName("Generate image", "generate_image")).toBe(true);
    expect(labelIsName("Gerar capa", "generate_image")).toBe(false);
  });

  test("Aprovar sempre and its rules, Composio's actions, a step's grey words", () => {
    expect(approveAlwaysWords(pt, { approveAlways: { tool: "generate_image", actions: [] } })).toBe("Gerar imagem");
    const rule = { tool: "generate_image", action: "", toolLabel: "Generate image", connectionId: "c1" };
    expect(approvalRuleWords(pt, rule)).toBe("Gerar imagem");
    expect(approvalRuleWords(pt, { ...rule, toolLabel: "Gerar capa" })).toBe("Gerar capa");
    expect(actionName(pt, "GITHUB_CREATE_AN_ISSUE_COMMENT")).toBe("Comentar numa issue (GitHub)");
    expect(actionName(pt, "ONE_DRIVE_ONEDRIVE_LIST_ITEMS")).toBe("Listar arquivos (OneDrive)");
    expect(toolLineHint(pt, { kind: "consulting", hint: "search issues", code: undefined, autoApproved: null })).toBe(
      "Buscar issues",
    );
    // A built-in's own detail stays as it is.
    expect(toolLineHint(pt, { kind: "openingSkill", hint: "relatorio", code: undefined, autoApproved: null })).toBe(
      "relatorio",
    );
  });
});
