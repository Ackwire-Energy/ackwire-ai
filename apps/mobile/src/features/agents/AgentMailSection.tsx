import { type AgentMailbox, useAgentMail, useMailAccounts, useSetAgentMail } from "@agenteschat/client";
import { LEVELS, type Level, nextLevel } from "@agenteschat/client/lib/access-levels";
import { canTalk } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { defaultPolicy, mailAccessOf, toMailLevel } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Card, Icon, Row, Section, Text, useToast } from "@/ui";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";

const toLevel = (l: AgentMailbox["level"]): Level => (l === "read_write" ? "write" : l);

/**
 * The agent's access to each connected mailbox (ADR 0038). Only who connected a mailbox gives access to it: on their
 * own a tap changes the level; on anyone else's the row says who gives it, and admins and the agent's owner may
 * remove it. Rules stay on the web.
 */
export function AgentMailSection({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const org = useOrg().org;
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const agent = dir.agentById.get(agentId);
  const accounts = useMailAccounts(orgId);
  const list = (accounts.data ?? []).filter((a) => a.status !== "pending");
  const mail = useAgentMail(orgId, agentId, list.length > 0);
  const set = useSetAgentMail(orgId);
  if (list.length === 0 || !mail.data) return null;
  const managesAgent = can(org, "manage_agents") || (!!meId && agent?.ownerUserId === meId);
  const save = (accountId: string, saved: AgentMailbox | undefined, level: Level) =>
    set.mutate(
      {
        agentId,
        accountId,
        input: {
          level: toMailLevel(level),
          canDelete: level === "none" ? false : (saved?.canDelete ?? false),
          policy: saved?.policy ?? defaultPolicy(),
        },
      },
      { onError: (e) => toast({ title: errorText(t, e), icon: "x" }) },
    );
  return (
    <Section title={t("mail.agent.title")}>
      <Card>
        {list.map((account) => {
          const saved = mail.data?.find((m) => m.accountId === account.id);
          const level = toLevel(saved?.level ?? "none");
          const may = mailAccessOf(account, { userId: meId, talks: canTalk(agent), managesAgent });
          const owner = account.ownerUserId ? dir.memberById.get(account.ownerUserId)?.name : undefined;
          const theirs = account.ownerUserId !== meId;
          return (
            <Row
              key={account.id}
              leading={<Icon name="mail" size={20} color={c.muted} />}
              title={account.address}
              {...(theirs
                ? {
                    subtitle: owner ? t("mail.agent.ownerOnly", { name: owner }) : t("mail.agent.ownerOnlyUnknown"),
                    subtitleLines: 2,
                  }
                : {})}
              meta={
                <Text variant="small" tone="muted">
                  {t(`access.level.${level}`)}
                </Text>
              }
              {...(may.gives && !set.isPending
                ? { onPress: () => save(account.id, saved, nextLevel({ levels: LEVELS }, level)) }
                : {})}
              {...(!may.gives && may.removes && level !== "none"
                ? {
                    below: (
                      <View style={styles.remove}>
                        <Button
                          variant="secondary"
                          size="sm"
                          label={t("mail.agent.remove")}
                          disabled={set.isPending}
                          onPress={() => save(account.id, saved, "none")}
                        />
                      </View>
                    ),
                  }
                : {})}
            />
          );
        })}
      </Card>
    </Section>
  );
}

const styles = StyleSheet.create({ remove: { marginTop: 6, alignSelf: "flex-start" } });
