import type { RunnerExecutorInfo, RunnerTools } from "@agenteschat/adapters/machine-protocol";
import type { ControlStatus } from "@agenteschat/adapters/runner-control";
import { Chip, Icon, type IconName, Switch } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useSnapshot, useStore } from "../../app";
import { pairedHomes } from "../../control/store";
import { useToast } from "../../ui/Toast";
import { CardTitle, PrefCard, PrefHead, PrefRow } from "./shared";

/** Tools are for the whole computer: every organization gets the same switch. */
export function Tools() {
  const { t } = useTranslation();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const homes = pairedHomes(snap);
  const tools: RunnerTools = homes.find((h) => h.access)?.access?.tools ?? {
    claude: false,
    codex: false,
    commands: false,
  };
  const executors: ControlStatus["executors"] = homes.find((h) => h.status)?.status?.executors ?? {};

  const set = async (tool: keyof RunnerTools, on: boolean) => {
    try {
      await store.requestAll({ type: "tools.set", tool, on });
      if (tool === "commands" && on) toast(t("desktop.prefs.tools.commandsOn"), "code");
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
  };

  const exec = (info: RunnerExecutorInfo | undefined) =>
    !info ? (
      <Chip icon="dash">{t("desktop.tools.notFound")}</Chip>
    ) : info.loggedIn === false ? (
      <Chip icon="alert" tone="waiting">
        {t("desktop.tools.loggedOut")}
      </Chip>
    ) : (
      <Chip icon="check" tone="done">
        {t("desktop.prefs.tools.connected")}
      </Chip>
    );

  const logo = (icon: IconName) => (
    <span className="dk-logo">
      <Icon name={icon} size={16} />
    </span>
  );

  return (
    <>
      <PrefHead title={t("desktop.prefs.tools.title")} lead={t("desktop.prefs.tools.lead")} />
      <PrefCard>
        <PrefRow
          top
          lead={logo("executorClaude")}
          htmlFor="tool-claude"
          title={
            <>
              {t("desktop.tools.claudeName")} {exec(executors.claude)}
            </>
          }
          desc={executors.claude ? t("desktop.tools.claudeDesc") : t("desktop.tools.notInstalled")}
          end={
            <Switch
              id="tool-claude"
              checked={tools.claude && !!executors.claude}
              disabled={!executors.claude || homes.length === 0}
              onCheckedChange={(on) => void set("claude", on)}
            />
          }
        />
        <PrefRow
          top
          lead={logo("executorCodex")}
          htmlFor="tool-codex"
          title={
            <>
              {t("desktop.tools.codexName")} {exec(executors.codex)}
            </>
          }
          desc={executors.codex ? t("desktop.tools.codexDesc") : t("desktop.tools.notInstalled")}
          end={
            <Switch
              id="tool-codex"
              checked={tools.codex && !!executors.codex}
              disabled={!executors.codex || homes.length === 0}
              onCheckedChange={(on) => void set("codex", on)}
            />
          }
        />
        <PrefRow
          top
          lead={logo("code")}
          htmlFor="tool-commands"
          title={t("desktop.tools.commandsName")}
          desc={t("desktop.tools.commandsDesc")}
          end={
            <Switch
              id="tool-commands"
              checked={tools.commands}
              disabled={homes.length === 0}
              onCheckedChange={(on) => void set("commands", on)}
            />
          }
          under={
            <span className="dk-honest">
              <Icon name="alert" size={14} />
              <span>{homes.length > 1 ? t("desktop.tools.commandsWarnOrgs") : t("desktop.tools.commandsWarn")}</span>
            </span>
          }
        />
      </PrefCard>

      <CardTitle>{t("desktop.prefs.tools.protection")}</CardTitle>
      <PrefCard>
        <PrefRow
          top
          lead={logo("shield")}
          htmlFor="protected-mode"
          title={
            <>
              {t("desktop.prefs.tools.protectedTitle")} <Chip icon="clock">{t("desktop.common.soon")}</Chip>
            </>
          }
          desc={t("desktop.prefs.tools.protectedDesc")}
          end={<Switch id="protected-mode" checked={false} disabled onCheckedChange={() => {}} />}
        />
      </PrefCard>
    </>
  );
}
