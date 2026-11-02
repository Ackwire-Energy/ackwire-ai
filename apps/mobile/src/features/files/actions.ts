import { type ArtifactDetail, useApi } from "@agenteschat/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, Alert, Platform } from "react-native";
import { useToast } from "@/ui";
import { useOrgId, useWhen } from "../shared/hooks";
import { whenKind } from "../shared/logic";
import { successHaptic } from "../shared/parts";
import { openInDrive, saveToPhotos, shareFile } from "./source";

/** Compartilhar, Salvar em Fotos and Ver no Drive for one file, with their toasts; one at a time. */
export function useFileActions(detail: ArtifactDetail | undefined) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const toast = useToast();
  const [busy, setBusy] = useState<"share" | "photos" | null>(null);

  const share = async () => {
    if (!detail || busy) return;
    setBusy("share");
    try {
      await shareFile(api, orgId, detail);
    } catch {
      toast({ title: t("mobile.files.shareFailed"), icon: "x" });
    } finally {
      setBusy(null);
    }
  };

  const savePhotos = async () => {
    if (!detail || busy) return;
    setBusy("photos");
    try {
      if (await saveToPhotos(api, orgId, detail)) {
        successHaptic();
        toast({ title: t("mobile.files.saved"), icon: "photos" });
      } else toast({ title: t("mobile.files.photosDenied"), subtitle: t("mobile.files.photosDeniedSub"), icon: "x" });
    } catch {
      toast({ title: t("mobile.files.saveFailed"), icon: "x" });
    } finally {
      setBusy(null);
    }
  };

  const drive = () => {
    if (!detail) return;
    openInDrive(orgId, detail).catch(() => toast({ title: t("mobile.files.loadFailed"), icon: "x" }));
  };

  /** The "…" of the top bar: the same actions as a native menu. */
  const more = (withPhotos: boolean) => {
    const items = [
      { label: t("mobile.files.share"), run: share },
      ...(withPhotos ? [{ label: t("mobile.files.savePhotos"), run: savePhotos }] : []),
      { label: t("mobile.files.drive"), run: drive },
    ];
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...items.map((i) => i.label), t("mobile.common.cancel")], cancelButtonIndex: items.length },
        (i) => {
          items[i]?.run();
        },
      );
      return;
    }
    Alert.alert(detail?.title ?? "", undefined, [
      ...items.map((i) => ({ text: i.label, onPress: () => void i.run() })),
      { text: t("mobile.common.cancel"), style: "cancel" as const },
    ]);
  };

  return { share, savePhotos, drive, more, busy };
}

/** "hoje 10:03", "ontem 18:20", "12 de out. 09:15": when the file was saved. */
export function useSavedWhen() {
  const when = useWhen();
  return (iso: string) => {
    const kind = whenKind(iso);
    const day =
      kind === "time" || kind === "yesterday"
        ? new Intl.RelativeTimeFormat(when.locale, { numeric: "auto" }).format(kind === "time" ? 0 : -1, "day")
        : when.short(iso);
    return `${day} ${when.time(iso)}`;
  };
}

/** The version shown was saved at… (a new version's time is the artifact's update). */
export const savedAt = (a: Pick<ArtifactDetail, "shownVersion" | "version" | "createdAt" | "updatedAt">) =>
  a.shownVersion === a.version ? a.updatedAt : a.createdAt;
