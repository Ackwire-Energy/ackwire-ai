import type { SkillChoice, SkillDetail, SkillFile } from "@agenteschat/client";
import { useSkill, useSkillAction, useSkills, useSkillUsage } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames, relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { pickSkills, skillChoicesOf } from "@agenteschat/client/lib/skills";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SearchField, Segmented, Text, useToast } from "@/ui";
import { Note } from "../ai/parts";
import { MessageText } from "../chat/MessageText";
import { useColors } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { useStepText } from "./hooks";
import { isGithubSkillLink, SKILLS_INLINE, searchSkills, skillLine, skillSourceKey } from "./logic";
import { confirmAction, Gap, SettingsPage } from "./parts";

/** Opens a skill of the library (its page). */
const openSkill = (id: string) => router.push(`/settings/skills/${id}`);

/**
 * Skills (admins), as the web's: the workspace's library, each skill with what it is for, where it came from, its
 * version and how many agents use it; "Instalar skill" first, a search once the list is long. A skill opens its page.
 */
export function SkillsScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const { orgId, org } = useOrg();
  const admin = can(org?.role, "configure");
  const skills = useSkills(orgId, admin);
  const list = skills.data ?? [];
  const usage = useSkillUsage(orgId, admin && list.length > 0);
  const [q, setQ] = useState("");
  const unavailable = skills.isError && (skills.error as { status?: number }).status === 404;
  const shown = searchSkills(list, q);
  return (
    <SettingsPage title={t("skills.title")}>
      <GroupedFooter>{t("settings.sectionText.skills")}</GroupedFooter>
      {!admin ? (
        <View style={styles.note}>
          <Note icon="lock">{t("settings.readOnly")}</Note>
        </View>
      ) : unavailable ? (
        <View style={styles.note}>
          <Note icon="info">{t("skills.unavailable")}</Note>
        </View>
      ) : (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="plus"
              label={t("skills.install")}
              chevron
              onPress={() => router.push("/settings/skills/new")}
            />
          </GroupedList>
          {list.length > SKILLS_INLINE ? (
            <View style={styles.search}>
              <SearchField
                value={q}
                onChangeText={setQ}
                placeholder={t("skills.search")}
                accessibilityLabel={t("skills.search")}
              />
            </View>
          ) : (
            <Gap />
          )}
          {skills.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
          {skills.isError && !skills.data ? (
            <View style={styles.note}>
              <Note icon="x">{t("common.loadFailed")}</Note>
            </View>
          ) : null}
          {skills.isSuccess && list.length === 0 ? <GroupedFooter>{t("skills.empty")}</GroupedFooter> : null}
          {list.length > 0 && shown.length === 0 ? (
            <GroupedFooter>{t("skills.noResults", { q: q.trim() })}</GroupedFooter>
          ) : null}
          {shown.length > 0 ? (
            <GroupedList>
              {shown.map((s) => (
                <GroupedRow
                  key={s.id}
                  label={s.name}
                  sub={s.description}
                  subLines={2}
                  below={
                    <Text variant="caption" tone="faint" numberOfLines={1}>
                      {skillLine(t, s, usage.get(s.id)?.length ?? 0)}
                    </Text>
                  }
                  chevron
                  onPress={() => openSkill(s.id)}
                />
              ))}
            </GroupedList>
          ) : null}
        </>
      )}
    </SettingsPage>
  );
}

/**
 * A skill's page (the web's sheet): where it came from, its version and when it changed under the title; what it is
 * for; its SKILL.md drawn; its files (scripts run on the agent's computer); then Editar, "Atualizar do link" for a
 * skill that came from a link, and Remover (the confirmation names the agents that lose it).
 */
export function SkillScreen({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const admin = can(org?.role, "configure");
  const skill = useSkill(orgId, id || null);
  const action = useSkillAction(orgId);
  const usage = useSkillUsage(orgId, admin);
  const s = skill.data;
  const users = usage.get(id) ?? [];
  const subtitle = s
    ? [
        t(`skills.source.${skillSourceKey(s)}`),
        t("skills.version", { version: s.version }),
        t("skills.updated", { when: relativeTime(t, i18n.language, s.updatedAt) }),
      ].join(" · ")
    : undefined;
  const failed = (e: unknown) => toast({ title: errorText(t, e), icon: "x" });

  const refresh = (item: SkillDetail) =>
    action.mutate(
      { type: "reimport", id: item.id },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("skills.refreshed", { name: item.name }), icon: "check" });
        },
        onError: failed,
      },
    );
  const remove = (item: SkillDetail) =>
    confirmAction({
      title: t("skills.removeTitle", { name: item.name }),
      text:
        users.length > 0
          ? t("skills.removeAgents", {
              count: users.length,
              names: joinNames(
                users.map((a) => a.name),
                t("newAgent.and"),
              ),
            })
          : t("skills.removeNone"),
      action: t("skills.remove"),
      cancel: t("common.cancel"),
      onConfirm: () =>
        action.mutate(
          { type: "remove", id: item.id },
          {
            onSuccess: () => {
              toast({ title: t("skills.removed", { name: item.name }), icon: "check" });
              goBack();
            },
            onError: failed,
          },
        ),
    });
  const fileFacts = (f: SkillFile): { value: string; sub?: string } =>
    f.status === "script"
      ? { value: t("skills.runsOnPc") }
      : f.status === "ignored"
        ? { value: t("skills.needsSandbox"), sub: t("skills.reinstall") }
        : { value: f.mime };

  return (
    <SettingsPage title={s?.name ?? t("skills.title")} subtitle={subtitle}>
      {skill.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {skill.isError && !s ? (
        <View style={styles.note}>
          <Note icon="x">{t("common.loadFailed")}</Note>
        </View>
      ) : null}
      {s ? (
        <>
          {s.description ? <GroupedFooter>{s.description}</GroupedFooter> : null}
          <Gap />
          <GroupedList>
            <View style={styles.page}>
              <MessageText body={s.body} />
            </View>
          </GroupedList>
          {s.files.length > 0 ? (
            <>
              <GroupedHeader>{t("skills.files")}</GroupedHeader>
              <GroupedList>
                {s.files.map((f) => (
                  <GroupedRow key={f.path} label={f.path} labelLines={2} {...fileFacts(f)} />
                ))}
              </GroupedList>
            </>
          ) : null}
          {admin ? (
            <>
              <Gap />
              <GroupedList>
                <GroupedRow
                  icon="pen"
                  label={t("skills.edit")}
                  chevron
                  onPress={() => router.push({ pathname: "/settings/skills/edit", params: { id: s.id } })}
                />
                {s.source === "url" && s.sourceUrl ? (
                  <GroupedRow
                    icon="down"
                    label={t("skills.refresh")}
                    disabled={action.isPending}
                    onPress={() => refresh(s)}
                  />
                ) : null}
                <GroupedRow
                  icon="x"
                  label={t("skills.remove")}
                  danger
                  disabled={action.isPending}
                  onPress={() => remove(s)}
                />
              </GroupedList>
            </>
          ) : null}
        </>
      ) : null}
    </SettingsPage>
  );
}

type InstallTab = "github" | "zip" | "write";

/**
 * "Instalar skill", as the web's dialog: from a GitHub link, a .zip from Arquivos, or written here. "Instalar" in the
 * bar; while it works, the step it is on; done, the skill's page in its place. A link holding several skills lists
 * them under the field, each checked to install, and "Instalar" installs those.
 */
export function InstallSkillScreen() {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const action = useSkillAction(orgId);
  const [tab, setTab] = useState<InstallTab>("github");
  const [url, setUrl] = useState("");
  const [zip, setZip] = useState<{ uri: string; name: string } | null>(null);
  const [form, setForm] = useState({ name: "", description: "", body: "" });
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [choices, setChoices] = useState<SkillChoice[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const busy = action.isPending || reading;
  const step = useStepText(busy, [
    t("skills.installStep.fetching"),
    t("skills.installStep.reading"),
    t("skills.installStep.saving"),
  ]);

  const done = (skill: unknown) => {
    const s = skill as SkillDetail;
    successHaptic();
    toast({ title: t("skills.installed", { name: s.name }), icon: "check" });
    router.replace(`/settings/skills/${s.id}`);
  };
  const onError = (e: unknown) => setError(errorText(t, e));
  const togglePick = (paths: string[], on: boolean) => setPicked(pickSkills(picked, paths, on));
  const pickZip = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: ["application/zip", "application/x-zip-compressed"],
      copyToCacheDirectory: true,
      multiple: false,
    });
    const a = res.canceled ? null : res.assets[0];
    if (!a) return;
    setZip({ uri: a.uri, name: a.name });
    setError(null);
  };
  const submit = async () => {
    if (busy) return;
    setError(null);
    if (tab === "github") {
      if (!isGithubSkillLink(url)) {
        setError(t("skills.githubInvalid"));
        return;
      }
      if (!choices) {
        const onSuccess = (result: unknown) => {
          const found = skillChoicesOf(result);
          if (!found) return done(result);
          setChoices(found);
          setPicked(new Set());
        };
        action.mutate({ type: "import", input: { url: url.trim() } }, { onSuccess, onError });
        return;
      }
      if (picked.size === 0) {
        setError(t("skills.pickMissing"));
        return;
      }
      const paths = choices.map((c) => c.path).filter((p) => picked.has(p));
      const onSuccess = (installed: unknown) => {
        const list = installed as SkillDetail[];
        if (list.length === 1) return done(list[0]);
        successHaptic();
        toast({ title: t("skills.installedMany", { count: list.length }), icon: "check" });
        goBack();
      };
      action.mutate({ type: "importPicked", url: url.trim(), paths }, { onSuccess, onError });
      return;
    }
    if (tab === "zip") {
      if (!zip) {
        setError(t("skills.zipMissing"));
        return;
      }
      setReading(true);
      let zipBase64: string;
      try {
        zipBase64 = await new File(zip.uri).base64();
      } catch {
        setError(t("common.unknownError"));
        return;
      } finally {
        setReading(false);
      }
      action.mutate({ type: "import", input: { zipBase64 } }, { onSuccess: done, onError });
      return;
    }
    if (!(form.name.trim() && form.description.trim() && form.body.trim())) {
      setError(t("skills.writeMissing"));
      return;
    }
    action.mutate(
      { type: "create", input: { name: form.name.trim(), description: form.description.trim(), body: form.body } },
      { onSuccess: done, onError },
    );
  };

  return (
    <SettingsPage
      title={t("skills.install")}
      action={{ label: t("skills.installSubmit"), disabled: busy, onPress: () => void submit() }}
    >
      <View style={styles.tabs}>
        <Segmented
          items={[
            { key: "github", label: t("skills.tab.github") },
            { key: "zip", label: t("skills.tab.zip") },
            { key: "write", label: t("skills.tab.write") },
          ]}
          value={tab}
          onChange={(k) => {
            setTab(k as InstallTab);
            setError(null);
          }}
        />
      </View>
      {tab === "github" ? (
        <>
          <GroupedHeader>{t("skills.githubUrl")}</GroupedHeader>
          <TextArea
            value={url}
            onChangeText={(next) => {
              setUrl(next);
              setChoices(null);
            }}
            placeholder="https://github.com/…"
            multiline={false}
            minHeight={50}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
            accessibilityLabel={t("skills.githubUrl")}
          />
          <GroupedFooter>
            {choices ? t("skills.pickLead", { count: choices.length }) : t("skills.githubHelp")}
          </GroupedFooter>
          {choices ? (
            <GroupedList>
              <GroupedRow
                label={t("skills.pickAll")}
                checked={picked.size === choices.length}
                onPress={() =>
                  togglePick(
                    choices.map((c) => c.path),
                    picked.size < choices.length,
                  )
                }
              />
              {choices.map((c) => (
                <GroupedRow
                  key={c.path}
                  label={c.name}
                  sub={c.description}
                  subLines={2}
                  checked={picked.has(c.path)}
                  onPress={() => togglePick([c.path], !picked.has(c.path))}
                />
              ))}
            </GroupedList>
          ) : null}
        </>
      ) : tab === "zip" ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="file"
              label={t("skills.zipPick")}
              sub={zip?.name ?? t("skills.zipNone")}
              chevron
              onPress={() => void pickZip()}
            />
          </GroupedList>
          <GroupedFooter>{t("skills.zipHelp")}</GroupedFooter>
        </>
      ) : (
        <>
          <GroupedHeader>{t("skills.name")}</GroupedHeader>
          <TextArea
            value={form.name}
            onChangeText={(name) => setForm((f) => ({ ...f, name }))}
            multiline={false}
            minHeight={50}
            accessibilityLabel={t("skills.name")}
          />
          <GroupedHeader>{t("skills.description")}</GroupedHeader>
          <TextArea
            value={form.description}
            onChangeText={(description) => setForm((f) => ({ ...f, description }))}
            minHeight={64}
            accessibilityLabel={t("skills.description")}
          />
          <GroupedFooter>{t("skills.descriptionHelp")}</GroupedFooter>
          <GroupedHeader>{t("skills.body")}</GroupedHeader>
          <TextArea
            value={form.body}
            onChangeText={(body) => setForm((f) => ({ ...f, body }))}
            minHeight={220}
            autoCapitalize="none"
            accessibilityLabel={t("skills.body")}
          />
          <GroupedFooter>{t("skills.bodyHelp")}</GroupedFooter>
        </>
      )}
      {error ? (
        <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      {step ? <GroupedFooter>{step}</GroupedFooter> : null}
    </SettingsPage>
  );
}

/**
 * Editar, pushed over a skill's page: what it is for, its instructions (saving makes a new version) and whether new
 * agents get it. "Salvar" in the bar saves and goes back.
 */
export function EditSkillScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const { orgId } = useOrg();
  const skill = useSkill(orgId, id || null);
  const action = useSkillAction(orgId);
  const s = skill.data;
  const [form, setForm] = useState<{ description: string; body: string; defaultForNewAgents: boolean } | null>(null);
  // Filled once, from the skill as it is: a refetch must not undo what is being typed.
  useEffect(() => {
    if (s && !form) setForm({ description: s.description, body: s.body, defaultForNewAgents: s.defaultForNewAgents });
  }, [s, form]);
  const ready = Boolean(form?.description.trim()) && !action.isPending;
  const save = () => {
    if (!s || !form || !ready) return;
    action.mutate(
      { type: "update", id: s.id, patch: form },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("skills.saved", { name: s.name }), icon: "check" });
          goBack();
        },
        onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
      },
    );
  };
  return (
    <SettingsPage
      title={t("skills.edit")}
      subtitle={s?.name}
      action={{ label: t("skills.save"), disabled: !ready, onPress: save }}
    >
      {!form ? (
        skill.isError ? (
          <View style={styles.note}>
            <Note icon="x">{t("common.loadFailed")}</Note>
          </View>
        ) : (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        )
      ) : (
        <>
          {s?.source === "url" ? <GroupedFooter>{t("skills.editLinkNote")}</GroupedFooter> : null}
          <GroupedHeader>{t("skills.description")}</GroupedHeader>
          <TextArea
            value={form.description}
            onChangeText={(description) => setForm({ ...form, description })}
            minHeight={64}
            accessibilityLabel={t("skills.description")}
          />
          <GroupedHeader>{t("skills.body")}</GroupedHeader>
          <TextArea
            value={form.body}
            onChangeText={(body) => setForm({ ...form, body })}
            minHeight={300}
            autoCapitalize="none"
            accessibilityLabel={t("skills.body")}
          />
          <GroupedFooter>{t("skills.newVersion")}</GroupedFooter>
          <Gap />
          <GroupedList>
            <GroupedRow
              label={t("skills.defaultForNew")}
              labelLines={2}
              toggle={form.defaultForNewAgents}
              onPress={() => setForm({ ...form, defaultForNewAgents: !form.defaultForNewAgents })}
            />
          </GroupedList>
        </>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  search: { paddingTop: 14, paddingBottom: 8 },
  loading: { marginVertical: 16 },
  page: { paddingHorizontal: 16, paddingVertical: 14 },
  tabs: { paddingTop: 10, paddingHorizontal: 4 },
  error: { paddingTop: 8, paddingHorizontal: 16 },
});
