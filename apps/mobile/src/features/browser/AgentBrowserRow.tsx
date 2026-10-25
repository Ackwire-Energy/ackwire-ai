import { isOpenHandoff, useAgentAccess, useAgentBrowserHandoff, useAgentBrowserSettings } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native";
import { Card, Row, Section, Text } from "@/ui";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { Tile } from "../shared/parts";
import { BrowserCard } from "./BrowserCard";
import { browserGranted, profileBrowserOf } from "./logic";

/**
 * "Navegador" on the agent's profile (ADR 0040 §9). Its owner and admins always have its browser here
 * while its computer serves it: the card shows it live while the agent works, and opens to watch, take
 * over and hand back, as in the conversation. Anyone else sees it while a person is in it; a request
 * waiting on them is a row to the request's conversation, where its card takes the control.
 */
export function AgentBrowserRow({ agentId, decides, busy }: { agentId: string; decides: boolean; busy: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const settings = useAgentBrowserSettings(orgId, agentId, decides);
  const access = useAgentAccess(orgId, agentId, decides);
  const open = useAgentBrowserHandoff(orgId, agentId);
  const handoff = open.data && isOpenHandoff(open.data) ? open.data : null;
  const show = profileBrowserOf(handoff, decides && settings.data?.available === true && browserGranted(access.data));
  if (!show) return null;
  const name = dir.agentById.get(agentId)?.name ?? "";
  return (
    <Section title={t("agentComputer.title", agentGrammar(t, name))}>
      {show === "waiting" && handoff ? (
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
      ) : (
        <BrowserCard
          agentId={agentId}
          handoff={handoff}
          busy={busy}
          computer={settings.data?.machine?.name}
          style={styles.flush}
        />
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  flush: { marginTop: 0 },
});
