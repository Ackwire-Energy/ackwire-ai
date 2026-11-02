import {
  useRoles,
  useSetWikiFolderAudience,
  useWikiAction,
  useWikiFolderAudience,
  useWikiPage,
  type WikiFolderAudience,
} from "@agenteschat/client";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import {
  OPEN_WIKI_ACCESS,
  type WikiAccess,
  type WikiAccessDraft,
  type WikiLevel,
  wikiAccessDraft,
  wikiAccessLimited,
  wikiAccessOf,
  wikiBaseLevels,
  wikiRowCap,
} from "@agenteschat/client/lib/wiki";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { Row, SectionHeader, Segmented, Text, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { ActionList, PushedHeader, successHaptic, Tile } from "../shared/parts";

/**
 * "Quem vê" a wiki page or folder (ADR 0023 addenda), the web's dialog as a screen: a level for everyone and one per
 * role, person and agent, people and agents apart. A tap walks a row through its levels. Owners always read and edit.
 * Inside a limited folder it can only be narrower.
 */
export function WikiAudienceScreen({ slug, folder }: { slug?: string; folder?: string }) {
  const orgId = useOrgId();
  const page = useWikiPage(orgId, slug ?? null);
  const info = useWikiFolderAudience(orgId, folder ?? "", Boolean(folder));
  const p = slug ? page.data : undefined;
  if (folder) {
    if (!info.data) return null;
    const { own, above } = info.data;
    return <Form key={folder} folder={folder} initial={own ?? above ?? OPEN_WIKI_ACCESS} above={above} />;
  }
  if (!p) return null;
  return (
    <Form
      key={p.id}
      slug={p.slug}
      inFolder={p.folder}
      initial={{
        audience: p.audience ?? null,
        agentIds: p.agentIds ?? null,
        editors: p.editors ?? null,
        agentEditorIds: p.agentEditorIds ?? null,
      }}
      above={p.folderAudience ?? null}
    />
  );
}

/** The levels a row walks through: on or off beside "everyone can view", or each one it may reach. */
const rowLevels = (base: WikiLevel, cap: WikiLevel): WikiLevel[] =>
  base === "view" ? ["none", "edit"] : cap === "edit" ? ["none", "view", "edit"] : ["none", "view"];

function Form({
  slug,
  folder,
  inFolder,
  initial,
  above,
}: {
  slug?: string;
  folder?: string;
  inFolder?: string;
  initial: WikiAccess;
  above: WikiFolderAudience | null;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const dir = useDirectory();
  const roles = useRoles(orgId);
  const action = useWikiAction(orgId);
  const saveFolder = useSetWikiFolderAudience(orgId);
  const [draft, setDraft] = useState<WikiAccessDraft>(() => wikiAccessDraft(initial));
  const cap = useMemo(() => wikiAccessDraft(above ?? OPEN_WIKI_ACCESS), [above]);
  const done = (title: string) => {
    successHaptic();
    toast({ title });
    router.back();
  };
  const save = () => {
    const access = wikiAccessOf(draft);
    if (folder) {
      saveFolder.mutate(
        { folder, access },
        {
          onSuccess: () =>
            done(wikiAccessLimited(access) ? t("wiki.audienceFolderSaved") : t("wiki.audienceFolderOpened")),
          onError: failed,
        },
      );
    } else if (slug) {
      action.mutate(
        { type: "audience", slug, access },
        {
          onSuccess: () => done(wikiAccessLimited(access) ? t("wiki.audienceSaved") : t("wiki.audienceOpened")),
          onError: failed,
        },
      );
    }
  };
  const levelName = (level: WikiLevel, base: WikiLevel) =>
    level === "edit"
      ? t("wiki.audienceLevelEdit")
      : level === "view" || base === "view"
        ? t("wiki.audienceLevelView")
        : t("wiki.audienceLevelNone");
  const row = (
    group: "roles" | "users" | "agentRows",
    base: WikiLevel,
    rowCap: WikiLevel,
    key: string,
    icon: "shield" | "person",
    label: string,
    hint?: string,
  ) => {
    const level = draft[group][key] ?? "none";
    const levels = rowLevels(base, rowCap);
    return {
      key,
      icon,
      label,
      ...(hint ? { hint } : {}),
      trailing: (
        <Text variant="subhead" tone="faint">
          {levelName(level, base)}
        </Text>
      ),
      onPress: () =>
        setDraft((d) => ({
          ...d,
          [group]: { ...d[group], [key]: levels[(levels.indexOf(level) + 1) % levels.length] ?? "none" },
        })),
    };
  };
  const baseItems = (allowed: WikiLevel[]) =>
    allowed.map((level) => ({
      key: level,
      label:
        level === "edit"
          ? t("wiki.audienceBaseEdit")
          : level === "view"
            ? t("wiki.audienceBaseView")
            : t("wiki.audienceBaseChosen"),
    }));
  const roleList = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))).filter(
    (r) => wikiRowCap(cap.people, cap.roles[r.id]) !== "none",
  );
  const agents = dir.agents.filter((a) => wikiRowCap(cap.agents, cap.agentRows[a.id]) !== "none");
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={t("wiki.audience")}
        solid={false}
        action={{ label: t("common.save"), onPress: save, disabled: action.isPending || saveFolder.isPending }}
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
        <View style={styles.list}>
          <Segmented
            items={baseItems(wikiBaseLevels(cap.people))}
            value={draft.people}
            onChange={(key) => setDraft((d) => ({ ...d, people: key as WikiLevel }))}
          />
        </View>
        {draft.people !== "edit" ? (
          <>
            <SectionHeader title={t("wiki.audienceRoles")} />
            <View style={styles.list}>
              <ActionList
                items={roleList.map((r) =>
                  row("roles", draft.people, wikiRowCap(cap.people, cap.roles[r.id]), r.id, "shield", r.name),
                )}
              />
            </View>
            <SectionHeader title={t("wiki.audiencePeople")} />
            <View style={styles.list}>
              <ActionList
                items={[...dir.memberById.values()].map((m) =>
                  row("users", draft.people, "edit", m.userId, "person", m.name, m.email),
                )}
              />
            </View>
          </>
        ) : null}
        <SectionHeader title={t("wiki.audienceAgents")} />
        <View style={styles.list}>
          <Segmented
            items={baseItems(wikiBaseLevels(cap.agents))}
            value={draft.agents}
            onChange={(key) => setDraft((d) => ({ ...d, agents: key as WikiLevel }))}
          />
        </View>
        {draft.agents !== "edit" ? (
          <View style={[styles.list, styles.rows]}>
            <ActionList
              items={agents.map((a) =>
                row("agentRows", draft.agents, wikiRowCap(cap.agents, cap.agentRows[a.id]), a.id, "person", a.name),
              )}
            />
          </View>
        ) : null}
        <Text variant="footnote" tone="faint" style={styles.lead}>
          {t("wiki.audienceEditNote")}
        </Text>
        {inFolder ? (
          <Row
            leading={<Tile icon="archive" />}
            title={t("wiki.audienceUseFolder", { folder: inFolder })}
            chevron
            onPress={() => router.push({ pathname: "/wiki-audience", params: { folder: inFolder } })}
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
  rows: { paddingTop: 12 },
});
