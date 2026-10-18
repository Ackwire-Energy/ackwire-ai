import { ApiError, keys, useApi, useMe, useSettings } from "@agenteschat/client";
import { browserTimezone, zoneDisplayName } from "@agenteschat/client/lib/routines";
import { filterZones, type ZoneOption, zoneOptions } from "@agenteschat/ui/timezones";
import { useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, Alert, FlatList, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { authClient } from "@/lib/auth";
import { useOrg } from "@/providers/org";
import {
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  PersonAvatar,
  SearchField,
  systemText,
  Text,
  useToast,
} from "@/ui";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { usePersonPhoto } from "../shared/photo";
import {
  type AccountDraft,
  accountChanges,
  accountProblem,
  handleErrorKey,
  PHOTO_MAX_BASE64,
  photoContentType,
} from "./logic";
import { Page, SheetBar } from "./parts";

/** A zone as the list says it: "Horário de Brasília" (a friendly name) or the city. */
const zoneName = (zone: string, locale: string) =>
  zoneDisplayName(zone, locale) ?? (zone.split("/").pop() ?? zone).replace(/_/g, " ");

/**
 * Conta (MobileRefinos.html, `vAcc`): the photo and "Alterar foto", Nome (editable), E-mail (read only),
 * then in this workspace your @ and the time zone, as the web's Perfil. "OK" saves; Apagar conta at the end.
 */
export function AccountPage({
  draft,
  setDraft,
  onBack,
  onZone,
  onDelete,
}: {
  draft: AccountDraft;
  setDraft: (draft: AccountDraft) => void;
  onBack: () => void;
  onZone: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const meId = useMeId();
  const org = useOrg();
  const dir = useDirectory();
  const mine = meId ? dir.memberById.get(meId) : undefined;
  const photo = usePersonPhoto(mine?.avatarUrl ?? mine?.image ?? me.data?.user.image);
  const [initial] = useState(draft);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = accountProblem(draft);
  const changes = accountChanges(initial, draft);
  const changed = Boolean(changes.name || changes.profile);
  // Show what's wrong once the person changed something (not on a fresh, untouched form).
  const shownProblem = changed && problem ? t(`mobile.me.account.${problem}`) : null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.me });
    void qc.invalidateQueries({ queryKey: keys.members(org.orgId) });
    void qc.invalidateQueries({ queryKey: keys.people(org.orgId) });
  };

  const save = async () => {
    if (!changed || problem || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (changes.name) {
        const res = await authClient.updateUser({ name: changes.name });
        if (res.error) throw new Error(res.error.message ?? "");
      }
      if (changes.profile) await api.orgs.updateMe(org.orgId, changes.profile);
      refresh();
      toast({ title: t("mobile.me.account.saved") });
      onBack();
    } catch (e) {
      const key = e instanceof ApiError ? handleErrorKey(e.code) : null;
      setError(key ? t(`mobile.me.account.${key}`) : t("mobile.app.failed"));
    } finally {
      setSaving(false);
    }
  };

  const upload = async (from: "library" | "camera") => {
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
      base64: true,
    };
    if (from === "camera") {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        toast({ title: t("mobile.me.account.noCamera"), icon: "camera" });
        return;
      }
    }
    const res =
      from === "camera"
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
    const a = res.canceled ? null : res.assets[0];
    if (!a?.base64) return;
    if (a.base64.length > PHOTO_MAX_BASE64) {
      toast({ title: t("mobile.me.account.photoTooBig"), icon: "x" });
      return;
    }
    setUploading(true);
    try {
      await api.orgs.setAvatar(org.orgId, {
        imageBase64: a.base64,
        contentType: photoContentType(a.mimeType, a.fileName),
      });
      refresh();
      toast({ title: t("mobile.me.account.photoSaved") });
    } catch {
      toast({ title: t("mobile.me.account.photoFailed"), icon: "x" });
    } finally {
      setUploading(false);
    }
  };

  const remove = async () => {
    try {
      await api.orgs.removeAvatar(org.orgId);
      refresh();
      toast({ title: t("mobile.me.account.photoRemoved") });
    } catch {
      toast({ title: t("mobile.app.failed"), icon: "x" });
    }
  };

  const changePhoto = () => {
    const hasPhoto = Boolean(mine?.avatarUrl);
    const labels = [
      t("mobile.me.account.fromLibrary"),
      t("mobile.me.account.fromCamera"),
      ...(hasPhoto ? [t("mobile.me.account.removePhoto")] : []),
    ];
    const run = (i: number) => {
      if (i === 0) void upload("library");
      else if (i === 1) void upload("camera");
      else if (i === 2 && hasPhoto) void remove();
    };
    if (Platform.OS === "ios")
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...labels, t("mobile.common.cancel")],
          cancelButtonIndex: labels.length,
          ...(hasPhoto ? { destructiveButtonIndex: 2 } : {}),
        },
        run,
      );
    else
      Alert.alert(t("mobile.me.account.changePhoto"), undefined, [
        ...labels.map((text, i) => ({ text, onPress: () => run(i) })),
        { text: t("mobile.common.cancel"), style: "cancel" as const },
      ]);
  };

  const input = [systemText("callout"), styles.input, { color: c.ink }];
  const zoneLabel = draft.zone ? zoneName(draft.zone, i18n.language) : t("mobile.me.account.orgZone");
  return (
    <Page
      title={t("mobile.me.account.title")}
      onBack={onBack}
      right={
        <Pressable
          onPress={() => void save()}
          disabled={!changed || Boolean(problem) || saving}
          accessibilityRole="button"
          accessibilityState={{ disabled: !changed || Boolean(problem) || saving }}
          hitSlop={8}
        >
          <Text variant="title" tone={!changed || problem || saving ? "faint" : "ink"}>
            {t("mobile.me.account.save")}
          </Text>
        </Pressable>
      }
    >
      <View style={styles.photo}>
        <PersonAvatar name={draft.name || "?"} size={92} photo={photo} />
        <Pressable onPress={changePhoto} disabled={uploading} accessibilityRole="button" hitSlop={8}>
          <Text variant="subhead" tone={uploading ? "faint" : "ink2"} style={styles.semibold}>
            {t("mobile.me.account.changePhoto")}
          </Text>
        </Pressable>
      </View>
      <GroupedList>
        <GroupedField label={t("mobile.me.account.name")}>
          <TextInput
            value={draft.name}
            onChangeText={(name) => setDraft({ ...draft, name })}
            placeholder={t("mobile.me.account.namePlaceholder")}
            placeholderTextColor={c.faint}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            returnKeyType="done"
            accessibilityLabel={t("mobile.me.account.name")}
            style={input}
          />
        </GroupedField>
        <GroupedField label={t("mobile.me.account.email")}>
          <Text variant="callout" tone="faint" numberOfLines={1}>
            {me.data?.user.email ?? ""}
          </Text>
        </GroupedField>
      </GroupedList>
      <GroupedHeader>{t("mobile.me.account.inWorkspace", { org: org.org?.name ?? "" })}</GroupedHeader>
      <GroupedList>
        <GroupedField label={t("mobile.me.account.handle")}>
          <View style={styles.handle}>
            <Text variant="callout" tone="faint">
              @
            </Text>
            <TextInput
              value={draft.handle}
              onChangeText={(handle) => setDraft({ ...draft, handle })}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              returnKeyType="done"
              accessibilityLabel={t("mobile.me.account.handle")}
              style={input}
            />
          </View>
        </GroupedField>
        <GroupedField label={t("mobile.me.account.timezone")} onPress={onZone}>
          <Text variant="callout" numberOfLines={1}>
            {zoneLabel}
          </Text>
        </GroupedField>
      </GroupedList>
      {shownProblem || error ? (
        <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
          {shownProblem ?? error}
        </Text>
      ) : null}
      <GroupedFooter>{t("mobile.me.account.footer")}</GroupedFooter>
      <View style={styles.gapBig} />
      <GroupedList>
        <GroupedRow icon="x" label={t("mobile.me.deleteAccount")} danger chevron onPress={onDelete} />
      </GroupedList>
    </Page>
  );
}

/** Fuso: "Usar o fuso do workspace", then the suggested zones and every other, with a search. */
export function ZonePage({
  value,
  onBack,
  onPick,
}: {
  value: string | null;
  onBack: () => void;
  onPick: (zone: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const org = useOrg();
  const settings = useSettings(org.orgId);
  const dir = useDirectory();
  const [query, setQuery] = useState("");
  const orgZone = settings.data?.timezone ?? null;
  const people = [...dir.memberById.values()].map((m) => m.timezone).join(",");
  const options = useMemo(() => {
    const suggested = [value ?? "", browserTimezone() ?? "", orgZone ?? "", ...people.split(","), "UTC"].filter(
      Boolean,
    );
    return zoneOptions(suggested, (z) => zoneDisplayName(z, i18n.language));
  }, [value, orgZone, people, i18n.language]);
  const q = query.trim();
  const rows: (ZoneOption | { header: string })[] = q
    ? filterZones([...options.suggested, ...options.rest], q)
    : [
        { header: t("mobile.me.zone.suggested") },
        ...options.suggested,
        { header: t("mobile.me.zone.all") },
        ...options.rest,
      ];

  return (
    <View style={styles.fill}>
      <SheetBar title={t("mobile.me.zone.title")} onBack={onBack} />
      <View style={styles.search}>
        <SearchField value={query} onChangeText={setQuery} placeholder={t("mobile.me.zone.search")} />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => ("header" in r ? `h:${r.header}` : r.zone)}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        initialNumToRender={20}
        contentContainerStyle={[styles.zoneList, { paddingBottom: 24 + insets.bottom }]}
        ListHeaderComponent={
          q ? undefined : (
            <GroupedList>
              <GroupedRow
                label={t("mobile.me.zone.useOrg")}
                {...(orgZone ? { sub: zoneName(orgZone, i18n.language) } : {})}
                checked={value === null}
                onPress={() => onPick(null)}
              />
            </GroupedList>
          )
        }
        ListEmptyComponent={<GroupedFooter>{t("mobile.me.zone.none")}</GroupedFooter>}
        renderItem={({ item }) =>
          "header" in item ? (
            <GroupedHeader>{item.header}</GroupedHeader>
          ) : (
            <ZoneRow option={item} checked={item.zone === value} onPress={() => onPick(item.zone)} />
          )
        }
      />
    </View>
  );
}

/** One zone (rows of the long list are flat: a hairline under each, no card per group). */
function ZoneRow({ option, checked, onPress }: { option: ZoneOption; checked: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <View style={[styles.zoneRow, { backgroundColor: c.raised, borderBottomColor: c.line2 }]}>
      <GroupedRow label={option.name} value={option.offsetLabel} checked={checked} onPress={onPress} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  photo: { alignItems: "center", gap: 8, paddingTop: 6, paddingBottom: 14 },
  semibold: { fontWeight: "600" },
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
  handle: { flexDirection: "row", alignItems: "center", gap: 1 },
  error: { paddingTop: 8, paddingHorizontal: 16 },
  gapBig: { height: 22 },
  search: { paddingHorizontal: 16, paddingBottom: 8 },
  zoneList: { paddingHorizontal: 16 },
  zoneRow: { borderBottomWidth: StyleSheet.hairlineWidth },
});
