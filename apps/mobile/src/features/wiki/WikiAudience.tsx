import { useRoles, useWikiAction, useWikiPage, type WikiAudience } from "@agenteschat/client";
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
 * "Quem vê" a wiki page (ADR 0023 addendum), the web's dialog as a screen: every member, or only agents and the
 * roles and people picked. Owners and agents always read it.
 */
export function WikiAudienceScreen({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const dir = useDirectory();
  const page = useWikiPage(orgId, slug);
  const roles = useRoles(orgId);
  const action = useWikiAction(orgId);
  const p = page.data;
  const [limited, setLimited] = useState<boolean | null>(null);
  const [value, setValue] = useState<WikiAudience | null>(null);
  const isLimited = limited ?? Boolean(p?.audience);
  const audience = value ?? p?.audience ?? { roleIds: [], userIds: [] };
  const flip = (key: keyof WikiAudience, id: string) =>
    setValue({
      ...audience,
      [key]: audience[key].includes(id) ? audience[key].filter((x) => x !== id) : [...audience[key], id],
    });
  const save = () => {
    if (!p) return;
    action.mutate(
      { type: "audience", slug: p.slug, audience: isLimited ? audience : null },
      {
        onSuccess: (x) => {
          successHaptic();
          toast({ title: x.audience ? t("wiki.audienceSaved") : t("wiki.audienceOpened") });
          router.back();
        },
        onError: failed,
      },
    );
  };
  const mode = (on: boolean, title: string, subtitle: string, icon: "globe" | "shield") => (
    <Row
      leading={<Tile icon={icon} />}
      title={title}
      subtitle={subtitle}
      subtitleLines={2}
      meta={isLimited === on ? <Icon name="check" size={20} color={c.ink} /> : undefined}
      onPress={() => setLimited(on)}
    />
  );
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={t("wiki.audience")}
        solid={false}
        action={{ label: t("common.save"), onPress: save, disabled: action.isPending || !p }}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <Text variant="footnote" tone="faint" style={styles.lead}>
          {t("wiki.audienceText")}
        </Text>
        {mode(false, t("wiki.audienceEveryone"), t("wiki.audienceEveryoneText"), "globe")}
        {mode(true, t("wiki.audienceLimited"), t("wiki.audienceLimitedText"), "shield")}
        {isLimited ? (
          <>
            <SectionHeader title={t("wiki.audienceRoles")} />
            <View style={styles.list}>
              <ActionList
                items={sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))).map((r) => ({
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
