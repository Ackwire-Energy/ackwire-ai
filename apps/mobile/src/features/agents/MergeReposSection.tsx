import { useAgentMergeRepos, useAgentRepos, useGitHubRepos, useSetAgentMergeRepos } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { mergeChoices } from "@agenteschat/client/lib/repos";
import { matchesWords } from "@agenteschat/ui/search";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native";
import { GroupedList, GroupedRow, SearchField, Section, Sheet, Text, useToast } from "@/ui";
import { useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";

/**
 * "Pode fazer merge sem perguntar", as under GitHub on the web's Ferramentas e acesso: where the agent merges with no
 * approval card. Its owner or an admin chooses in a sheet, each switch saved at once. Shown only when there is
 * something chosen, or something to choose.
 */
export function MergeReposSection({ agentId, name, mayEdit }: { agentId: string; name: string; mayEdit: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const merge = useAgentMergeRepos(orgId, agentId);
  const save = useSetAgentMergeRepos(orgId, agentId);
  const reach = useAgentRepos(orgId, agentId, mayEdit);
  const listing = useGitHubRepos(orgId, mayEdit);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");
  const list = merge.data ?? [];
  const choices = mergeChoices(listing.data, reach.data ?? []);
  if (!merge.data || (list.length === 0 && !(mayEdit && choices.length > 0))) return null;
  const toggle = (repo: string) =>
    save.mutate(list.includes(repo) ? list.filter((r) => r !== repo) : [...list, repo], {
      onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
    });
  return (
    <Section title={t("repos.merge.label")}>
      <GroupedList>
        {list.map((repo) => (
          <GroupedRow key={repo} label={repo} icon="code" />
        ))}
        {mayEdit ? (
          <GroupedRow
            label={list.length === 0 ? t("repos.choose") : t("repos.change")}
            chevron
            onPress={() => setPicking(true)}
          />
        ) : null}
      </GroupedList>
      <Text variant="small" tone="muted" style={styles.foot}>
        {list.length === 0 ? t("repos.merge.none") : t("repos.merge.help")}
      </Text>
      <Sheet open={picking} onClose={() => setPicking(false)}>
        <SheetTitle title={t("repos.merge.dialogTitle", agentGrammar(name))} />
        <SearchField value={q} onChangeText={setQ} placeholder={t("repos.search")} autoCorrect={false} />
        <GroupedList>
          {choices
            .filter((repo) => !q.trim() || matchesWords(repo, q))
            .map((repo) => (
              <GroupedRow
                key={repo}
                label={repo}
                toggle={list.includes(repo)}
                disabled={save.isPending}
                onPress={() => toggle(repo)}
              />
            ))}
        </GroupedList>
      </Sheet>
    </Section>
  );
}

const styles = StyleSheet.create({ foot: { paddingHorizontal: 4, marginTop: 8 } });
