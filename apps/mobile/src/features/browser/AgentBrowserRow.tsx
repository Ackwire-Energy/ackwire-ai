import { isOpenHandoff, useAgentBrowserHandoff, useAgentBrowserSettings } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Card, Row, Section, Text } from "@/ui";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { Tile } from "../shared/parts";

/**
 * "Navegador" on the agent's profile (NavegadorAgente.html, "Assistindo"): when it waits on someone in its
 * browser, Abrir; otherwise Ver ao vivo, which opens the live view (Assumir there). Nothing when the agent
 * can't use a browser. Settings stay on the web.
 */
export function AgentBrowserRow({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const settings = useAgentBrowserSettings(orgId, agentId);
  const open = useAgentBrowserHandoff(orgId, agentId);
  const handoff = open.data && isOpenHandoff(open.data) ? open.data : null;
  if (!settings.data?.available && !handoff) return null;
  const name = dir.agentById.get(agentId)?.name ?? "";
  return (
    <Section title={t("mobile.browser.profile.title")}>
      <Card>
        <Row
          leading={<Tile icon="globe" />}
          title={
            handoff ? t(`mobile.browser.profile.waiting${genderOf(name)}`, { name }) : t("mobile.browser.profile.watch")
          }
          {...(handoff
            ? {
                subtitle: handoff.instructions,
                meta: (
                  <Text variant="small" style={{ color: c.amber, fontWeight: "500" }}>
                    {t("mobile.browser.card.open")}
                  </Text>
                ),
              }
            : {})}
          chevron
          onPress={() => router.push(handoff ? `/handoff/${handoff.id}` : `/browser/${agentId}`)}
        />
      </Card>
    </Section>
  );
}
