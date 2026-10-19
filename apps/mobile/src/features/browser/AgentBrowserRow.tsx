import { isOpenHandoff, useAgentBrowserHandoff } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Card, Row, Section, Text } from "@/ui";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { Tile } from "../shared/parts";

/**
 * "Navegador" on the agent's profile, only while it waits on someone in its browser: Abrir goes to the
 * request's conversation, where its card takes the control (NavegadorNoChat A). Watching the agent at
 * work happens in the conversation it works in; settings stay on the web.
 */
export function AgentBrowserRow({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const open = useAgentBrowserHandoff(orgId, agentId);
  const handoff = open.data && isOpenHandoff(open.data) ? open.data : null;
  if (!handoff) return null;
  const name = dir.agentById.get(agentId)?.name ?? "";
  return (
    <Section title={t("mobile.browser.profile.title")}>
      <Card>
        <Row
          leading={<Tile icon="globe" />}
          title={t(`mobile.browser.profile.waiting${genderOf(name)}`, { name })}
          subtitle={handoff.instructions}
          meta={
            <Text variant="small" style={{ color: c.amber, fontWeight: "500" }}>
              {t("mobile.browser.card.open")}
            </Text>
          }
          chevron
          onPress={() => router.push(`/handoff/${handoff.id}`)}
        />
      </Card>
    </Section>
  );
}
