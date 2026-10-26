import { useComputerSetup, useMachines, useMe } from "@agenteschat/client";
import {
  etaLine,
  promisesEmail,
  SETUP_STEPS,
  type SetupView,
  setupEta,
  setupPending,
  setupPortrait,
  setupView,
  useEtaNow,
  WORKSPACE_COMPUTER_KIND,
} from "@agenteschat/client/lib/computer";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { ComputerIcon, ComputerPortrait } from "@/computer/ComputerPortrait";
import { useOrg } from "@/providers/org";
import { Button, Icon, type IconName, InfoHint, LineIcon, SheetScreen, Text } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { tapHaptic, useSurface } from "../shared/parts";
import { setupNoticeLine } from "./logic";

/** This workspace's computer on its way, or null where people connect their own (`pair`). */
export function useSetupView(): SetupView | null {
  const q = useComputerSetup(useOrgId());
  return setupView(q.data, q.dataUpdatedAt);
}

/**
 * The time left now, on the clock every time line shares (`useEtaNow`), and whether "we'll email you" holds for
 * this person: only owners get the email. A workspace on hold shows neither: its provisioner waits too. `now`:
 * that clock's time, while it waits.
 */
export function useSetupWait(view: SetupView | null) {
  const { org } = useOrg();
  const email = useMe().data?.user.email ?? "";
  const live = view && setupPending(view) && org?.standing?.state !== "hold" ? view : null;
  const now = useEtaNow(live !== null);
  return {
    now: live ? now : null,
    /** Lines about the wait show (not ready, not on hold). */
    live: live !== null,
    eta: live ? setupEta(live, now) : null,
    emailed: live !== null && org?.role === "owner" && promisesEmail(live, now),
    email,
  };
}

/** The four steps as bars: the ones done full, the current one half. */
function Steps({ n, total }: { n: number; total: number }) {
  const c = useColors();
  return (
    <View style={styles.steps} importantForAccessibility="no-hide-descendants">
      {Array.from({ length: total }, (_, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed bars, never reordered
          key={i}
          style={[styles.bar, { backgroundColor: i < n ? c.ink : c.line, opacity: i === n - 1 ? 0.5 : 1 }]}
        />
      ))}
    </View>
  );
}

function Line({ icon, text }: { icon: IconName; text: string }) {
  const c = useColors();
  return (
    <View style={styles.line}>
      <LineIcon variant="small" name={icon} size={16} color={c.muted} />
      <Text variant="small" tone="muted" style={styles.grow}>
        {text}
      </Text>
    </View>
  );
}

/**
 * The workspace's computer on its way, as the web's preparing screen: the server's portrait, "Preparando o
 * computador da Acme" with its ⓘ (one user per agent), the steps ("Passo 3 de 4 · Instalando os programas") or why
 * it waits, the time left, who hears when it's ready (owners, by email) and the size. Ready: its name.
 */
export function SetupWait({ view, online = false }: { view: SetupView; online?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const wait = useSetupWait(view);
  const orgName = org?.name ?? "";
  const pending = setupPending(view);
  const name = t("computerSetup.title", { org: orgName });
  return (
    <View style={styles.wait}>
      <View style={styles.head}>
        <ComputerPortrait kind={WORKSPACE_COMPUTER_KIND} state={setupPortrait(view, online)} size={96} />
        <InfoHint name={t("common.about", { label: name })} text={t("computerSetup.users")} variant="title" center>
          <Text variant="title" style={styles.center}>
            {pending ? t("computerSetup.notice.title", { org: orgName }) : name}
          </Text>
        </InfoHint>
        {view.step ? (
          <>
            <Steps n={view.stepNumber} total={SETUP_STEPS.length} />
            <Text variant="small" tone="muted" style={styles.center}>
              {t("computerSetup.stepOf", { n: view.stepNumber, total: SETUP_STEPS.length, step: t(view.textKey) })}
            </Text>
          </>
        ) : (
          <Text variant="small" tone="muted" style={styles.center}>
            {t(view.textKey)}
          </Text>
        )}
        {wait.eta ? (
          <Text variant="callout" tone="ink" accessibilityLiveRegion="polite" style={[styles.center, styles.bold]}>
            {etaLine(t, wait.eta)}
          </Text>
        ) : null}
      </View>
      {wait.live ? (
        <Line
          icon={wait.emailed ? "mail" : "bell"}
          text={wait.emailed ? t("computerSetup.email.you", { email: wait.email }) : t("computerSetup.email.here")}
        />
      ) : null}
      {view.specs ? <Line icon="server" text={t("computerSetup.specs", view.specs)} /> : null}
    </View>
  );
}

/** The whole wait, opened from the notice: it turns Ready once the computer is, live. */
export function ComputerSetupSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const view = useSetupView();
  const managed = useMachines(orgId).data?.find((m) => m.kind === "managed");
  return (
    <SheetScreen>
      {view ? <SetupWait view={view} online={managed?.online ?? false} /> : null}
      <Button variant="secondary" wide label={t("mobile.common.close")} onPress={onClose} />
    </SheetScreen>
  );
}

/**
 * On Conversas while the workspace's own computer is being prepared, in the outage notices' style: "Preparando
 * o computador da Acme" and the time left (or where it is). It opens the whole wait in a sheet. Everyone sees it.
 */
export function SetupNotice() {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const { org } = useOrg();
  const view = useSetupView();
  const wait = useSetupWait(view);
  if (!setupPending(view)) return null;
  const title = t("computerSetup.notice.title", { org: org?.name ?? "" });
  const line = setupNoticeLine(t, view, wait.eta, wait.emailed);
  return (
    <View style={styles.list}>
      <Pressable
        onPress={() => {
          tapHaptic();
          router.push("/computer-setup");
        }}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${line}`}
        style={[styles.card, surface]}
      >
        <ComputerIcon kind={WORKSPACE_COMPUTER_KIND} size={22} color={c.muted} />
        <View style={styles.grow}>
          <Text variant="callout" tone="ink" style={styles.bold} numberOfLines={2}>
            {title}
          </Text>
          <Text variant="small" tone="muted" numberOfLines={2}>
            {line}
          </Text>
        </View>
        <Icon name="right" size={16} color={c.faint} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wait: { gap: 12 },
  head: { alignItems: "center", gap: 8, paddingBottom: 4 },
  center: { textAlign: "center" },
  bold: { fontWeight: "600" },
  steps: { flexDirection: "row", gap: 6, alignSelf: "stretch", paddingHorizontal: 24, paddingTop: 4 },
  bar: { flex: 1, height: 4, borderRadius: 2 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  grow: { flex: 1, minWidth: 0 },
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  card: {
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
});
