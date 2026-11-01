import {
  useRoles,
  useSetWikiFolderAudience,
  useWikiAction,
  useWikiFolderAudience,
  useWikiPage,
  type WikiAudience,
  type WikiFolderAudience,
} from "@agenteschat/client";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { Icon, Row, SectionHeader, Text, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { ActionList, PushedHeader, successHaptic, Tile } from "../shared/parts";

/**
 * "Quem vê" a wiki page or folder (ADR 0023 addendum), the web's dialog as a screen: people and agents are chosen
 * apart. Owners always read it. Inside a limited folder it can only be narrower.
 */
export function WikiAudienceScreen({ slug, folder }: { slug?: string; folder?: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const dir = useDirectory();
  const page = useWikiPage(orgId, slug ?? null);
  const roles = useRoles(orgId);
  const action = useWikiAction(orgId);
  const saveFolder = useSetWikiFolderAudience(orgId);
  const info = useWikiFolderAudience(orgId, folder ?? "", Boolean(folder));
  const p = slug ? page.data : undefined;
  const above: WikiFolderAudience | null = (folder ? info.data?.above : p?.folderAudience) ?? null;
  const base = folder ? (info.data?.own ?? above) : p;
  const ready = Boolean(folder ? info.data : p);
  const [limited, setLimited] = useState<boolean | null>(null);
  const [value, setValue] = useState<WikiAudience | null>(null);
  const [agentsOnly, setAgentsOnly] = useState<boolean | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const isLimited = limited ?? Boolean(base?.audience ?? above?.audience);
  const audience = value ?? base?.audience ?? above?.audience ?? { roleIds: [], userIds: [] };
  const isAgentsOnly = agentsOnly ?? Boolean(base?.agentIds ?? above?.agentIds);
  const agentIds = picked ?? base?.agentIds ?? above?.agentIds ?? [];
  const flip = (key: keyof WikiAudience, id: string) =>
    setValue({
      ...audience,
      [key]: audience[key].includes(id) ? audience[key].filter((x) => x !== id) : [...audience[key], id],
    });
  const done = (title: string) => {
    successHaptic();
    toast({ title });
    router.back();
  };
  const save = () => {
    const choice = { audience: isLimited ? audience : null, agentIds: isAgentsOnly ? agentIds : null };
    if (folder) {
      saveFolder.mutate(
        { folder, ...choice },
        {
          onSuccess: () =>
            done(choice.audience || choice.agentIds ? t("wiki.audienceFolderSaved") : t("wiki.audienceFolderOpened")),
          onError: failed,
        },
      );
    } else if (p) {
      action.mutate(
        { type: "audience", slug: p.slug, ...choice },
        {
          onSuccess: (x) => done(x.audience || x.agentIds ? t("wiki.audienceSaved") : t("wiki.audienceOpened")),
          onError: failed,
        },
      );
    }
  };
  const option = (
    on: boolean,
    title: string,
    subtitle: string,
    icon: "globe" | "shield",
    locked: boolean,
    pick: () => void,
  ) => (
    <Row
      leading={<Tile icon={icon} />}
      title={title}
      subtitle={subtitle}
      subtitleLines={2}
      meta={on ? <Icon name="check" size={20} color={c.ink} /> : undefined}
      {...(locked ? {} : { onPress: pick })}
    />
  );
  const roleList = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))).filter(
    (r) => !above?.audience || above.audience.roleIds.includes(r.id),
  );
  const agents = dir.agents.filter((a) => !a.archivedAt && (!above?.agentIds || above.agentIds.includes(a.id)));
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={t("wiki.audience")}
        solid={false}
        action={{
          label: t("common.save"),
          onPress: save,
          disabled: action.isPending || saveFolder.isPending || !ready,
        }}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <Text variant="footnote" tone="faint" style={styles.lead}>
          {folder ? t("wiki.audienceFolderText") : t("wiki.audienceText")}
        </Text>
        {above ? (
          <Text variant="footnote" tone="faint" style={styles.lead}>
            {t("wiki.audienceInFolder", { folder: above.folder })}
          </Text>
        ) : null}
        <SectionHeader title={t("wiki.audiencePeople")} />
        {option(
          !isLimited,
          t("wiki.audienceEveryone"),
          t("wiki.audienceEveryoneText"),
          "globe",
          Boolean(above?.audience),
          () => setLimited(false),
        )}
        {option(isLimited, t("wiki.audienceLimited"), t("wiki.audienceLimitedText"), "shield", false, () =>
          setLimited(true),
        )}
        {isLimited ? (
          <>
            <SectionHeader title={t("wiki.audienceRoles")} />
            <View style={styles.list}>
              <ActionList
                items={roleList.map((r) => ({
                  key: r.id,
                  icon: "shield",
                  label: r.name,
                  checked: audience.roleIds.includes(r.id),
                  onPress: () => flip("roleIds", r.id),
                }))}
              />
            </View>
            <SectionHeader title={t("wiki.audiencePeople")} />
            <View style={styles.list}>
              <ActionList
                items={[...dir.memberById.values()].map((m) => ({
                  key: m.userId,
                  icon: "person",
                  label: m.name,
                  hint: m.email,
                  checked: audience.userIds.includes(m.userId),
                  onPress: () => flip("userIds", m.userId),
                }))}
              />
            </View>
          </>
        ) : null}
        <SectionHeader title={t("wiki.audienceAgents")} />
        {option(
          !isAgentsOnly,
          t("wiki.audienceAgentsAll"),
          t("wiki.audienceAgentsAllText"),
          "globe",
          Boolean(above?.agentIds),
          () => setAgentsOnly(false),
        )}
        {option(isAgentsOnly, t("wiki.audienceAgentsOnly"), t("wiki.audienceAgentsOnlyText"), "shield", false, () =>
          setAgentsOnly(true),
        )}
        {isAgentsOnly ? (
          <View style={styles.list}>
            <ActionList
              items={agents.map((a) => ({
                key: a.id,
                icon: "person",
                label: a.name,
                checked: agentIds.includes(a.id),
                onPress: () =>
                  setPicked(agentIds.includes(a.id) ? agentIds.filter((x) => x !== a.id) : [...agentIds, a.id]),
              }))}
            />
          </View>
        ) : null}
        {p?.folder ? (
          <Row
            leading={<Tile icon="archive" />}
            title={t("wiki.audienceUseFolder", { folder: p.folder })}
            chevron
            onPress={() => router.push({ pathname: "/wiki-audience", params: { folder: p.folder } })}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingBottom: 40 },
  lead: { paddingHorizontal: 20, paddingVertical: 12 },
  list: { paddingHorizontal: 16 },
});
