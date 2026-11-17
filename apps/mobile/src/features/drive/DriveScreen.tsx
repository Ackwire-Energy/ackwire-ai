import { useArtifacts } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  Filters,
  SCREEN_X,
  SearchField,
  SectionHeader,
  SkeletonList,
  useReducedMotion,
} from "@/ui";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { DriveCard, driveRef, UploadingCard } from "./DriveCard";
import {
  DRIVE_TYPES,
  type DriveDaySection,
  type DriveType,
  driveFilters,
  driveSections,
  driveView,
  gridRows,
  keepsLooking,
  matchesType,
} from "./logic";
import { useDriveUpload } from "./useDriveUpload";

/** Cards shown at first and added by "Mostrar mais" (each card loads its own preview). */
const PAGE = 24;

/**
 * Drive, pushed from Você: the search, the type chips (Tudo, Documentos, Imagens, Tabelas, Diffs), and everything the
 * person can see grouped by day (Hoje, Esta semana, then by month) in a two-column grid of real previews, and a file
 * sent from the phone. A card opens the file as every file opens. `highlightId`: the item "Ver no Drive" came from,
 * outlined.
 *
 * A chip narrows the list on the server to the kinds that can hold its type (`driveFilters`); an uploaded file is one
 * kind there whatever it holds, so the phone keeps the files its name says are of the type, and reads the server's
 * next pages by itself until it has a page of them to show or the server has no more (`keepsLooking`), the rows'
 * shape on screen while it finds none yet.
 */
export function DriveScreen({ highlightId = null }: { highlightId?: string | null }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const when = useWhen();
  const [q, setQ] = useState("");
  const [type, setType] = useState<DriveType>("all");
  const [shown, setShown] = useState(PAGE);
  const search = useDeferredValue(q.trim());
  const filters = useMemo(() => driveFilters(search, type), [search, type]);
  const list = useArtifacts(orgId, filters);
  const pull = usePullRefresh(list.refetch);
  const matches = useMemo(() => (list.artifacts ?? []).filter((a) => matchesType(a, type)), [list.artifacts, type]);
  const hasNextPage = Boolean(list.hasNextPage);
  const looking = keepsLooking({
    matched: matches.length,
    wanted: shown,
    hasNextPage,
    fetching: list.isFetching,
    placeholder: list.isPlaceholderData,
    failed: list.isFetchNextPageError,
  });
  const { fetchNextPage } = list;
  useEffect(() => {
    if (looking) void fetchNextPage();
  }, [looking, fetchNextPage]);
  // Newest first; the highlighted item is always among those shown.
  const sections = useMemo(() => {
    const sorted = [...matches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const at = highlightId ? sorted.findIndex((a) => a.id === highlightId) : -1;
    return driveSections(sorted.slice(0, Math.max(shown, at + 1)));
  }, [matches, shown, highlightId]);
  // What the grid shows, in its order: a picture or a video opens among the grid's others, to swipe through.
  const shownRefs = useMemo(() => sections.flatMap((s) => s.items.map(driveRef)), [sections]);
  const label = (s: DriveDaySection) =>
    s.label.kind === "month"
      ? new Intl.DateTimeFormat(when.locale, {
          month: "long",
          ...(s.label.year !== new Date().getFullYear() ? { year: "numeric" as const } : {}),
        })
          .format(new Date(s.label.year, s.label.month, 1))
          .replace(/^./, (x) => x.toLocaleUpperCase())
      : t(`mobile.drive.section.${s.label.kind}`);
  const mayUpload = can(useOrg().org, "upload_files");
  const uploader = useDriveUpload(list.refetch);
  const clear = () => {
    setQ("");
    setType("all");
    setShown(PAGE);
  };
  const visible = sections.reduce((n, s) => n + s.items.length, 0);
  const view = driveView({
    loading: list.isLoading,
    // Nothing to show: the first page didn't load, or the next one failed before any file of the type turned up.
    failed: (list.isError && !list.data) || (list.isFetchNextPageError && matches.length === 0),
    matched: matches.length,
    hasNextPage,
    placeholder: list.isPlaceholderData,
    filtered: search !== "" || type !== "all",
  });
  // The grid fades in over the rows' shape, and a day that comes with "Show more" fades in under the others; what
  // shows when the screen opens doesn't fade card by card.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  return (
    <PushedLargeTitle
      title={t("mobile.drive.title")}
      {...(mayUpload
        ? {
            actions: [
              { icon: "plus", sf: "plus", label: t("files.upload"), disabled: uploader.busy, onPress: uploader.pick },
            ],
          }
        : {})}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("mobile.drive.search")}
          accessibilityLabel={t("mobile.drive.search")}
          returnKeyType="search"
        />
      </View>
      <Filters
        items={DRIVE_TYPES.map((k) => ({ key: k, label: t(`mobile.drive.type.${k}`) }))}
        value={type}
        onChange={(k) => {
          setType(k as DriveType);
          setShown(PAGE);
        }}
      />
      {view === "loading" ? (
        // Loading, or still looking for files of the type: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : view === "failed" ? (
        <LoadFailed onRetry={() => void (list.isFetchNextPageError ? fetchNextPage() : list.refetch())} />
      ) : view === "noMatch" ? (
        <EmptyState
          size="inline"
          title={t("mobile.drive.noResults")}
          action={<Button variant="secondary" size="sm" label={t("filters.clearAll")} onPress={clear} />}
        />
      ) : view === "empty" ? (
        <FirstUse
          place="drive"
          acts={mayUpload}
          label={t("files.upload")}
          busy={uploader.busy}
          onPress={uploader.pick}
        />
      ) : (
        <Animated.View {...fade}>
          <LayoutAnimationConfig skipEntering>
            {/* A file on its way in holds a card's place above the days, so a large one shows it's going. */}
            {uploader.uploading !== null ? (
              <Animated.View {...fade} style={[styles.row, styles.uploading]}>
                <UploadingCard name={uploader.uploading} />
                <View style={styles.spacer} />
              </Animated.View>
            ) : null}
            {sections.map((s) => (
              <Animated.View key={s.key} {...fade}>
                <SectionHeader title={label(s)} count={s.items.length} />
                <View style={styles.grid}>
                  {gridRows(s.items).map((row) => (
                    <View key={row.map((a) => a.id).join(":")} style={styles.row}>
                      {row.map((a) => (
                        <DriveCard key={a.id} artifact={a} highlighted={a.id === highlightId} siblings={shownRefs} />
                      ))}
                      {row.length === 1 ? <View style={styles.spacer} /> : null}
                    </View>
                  ))}
                </View>
              </Animated.View>
            ))}
            {visible < matches.length || hasNextPage ? (
              // Centred across the screen inside its margins (a button keeps to its own width at the row's start).
              <View style={styles.more}>
                <Button
                  variant="secondary"
                  size="sm"
                  label={t("mobile.drive.more")}
                  loading={list.isFetchingNextPage}
                  onPress={() => {
                    setShown((n) => n + PAGE);
                    // A page that failed is asked for again only when the person asks for more.
                    if (list.isFetchNextPageError) void fetchNextPage();
                  }}
                />
              </View>
            ) : null}
          </LayoutAnimationConfig>
        </Animated.View>
      )}
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: SCREEN_X, paddingBottom: 10 },
  grid: { paddingHorizontal: SCREEN_X, gap: 16 },
  row: { flexDirection: "row", gap: 12 },
  uploading: { paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 4 },
  spacer: { flex: 1 },
  more: { flexDirection: "row", justifyContent: "center", paddingHorizontal: SCREEN_X, paddingTop: 20 },
});
