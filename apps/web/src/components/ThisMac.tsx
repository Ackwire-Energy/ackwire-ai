import { useConfirmDevice } from "@agenteschat/client";
import { Button } from "@agenteschat/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { inDesktopApp, thisMac } from "@/lib/desktop";
import { useToast } from "@/lib/toast";

/**
 * This Mac, in agentes for Mac (D79, telas/AppDesktop.html "Este Mac"): the
 * site knows which organizations the Mac it runs on is connected to, connects
 * it in one click (no code to read: the app hands the runner's code to the
 * site, which confirms it with the person's session) and opens the app's
 * Preferences where access is granted. Outside the app, nothing.
 */
const THIS_MAC_KEY = ["desktop", "thisMac"] as const;
/** Ask again this often while the runner picks up its token after the site confirmed. */
const CONNECTING_POLL_MS = 2000;

/** This Mac in `orgId`: its machine there, or null when it isn't connected to it. Off outside the app. */
export function useThisMac(orgId: string, connecting = false) {
  return useQuery({
    queryKey: THIS_MAC_KEY,
    queryFn: thisMac.status,
    enabled: inDesktopApp(),
    refetchInterval: connecting ? CONNECTING_POLL_MS : false,
    refetchOnWindowFocus: true,
    select: (s) => s.orgs.find((o) => o.orgId === orgId && o.connection !== "refused") ?? null,
    meta: { quiet: true },
  });
}

/** Is `machineId` the Mac this app runs on? */
export function useIsThisMac(orgId: string, machineId: string) {
  return useThisMac(orgId).data?.machineId === machineId;
}

/** "Usar este Mac" (one click), or, once connected, "Pastas deste Mac". `canPair`: may connect a computer. */
export function ThisMacButton({
  orgId,
  canPair,
  primary = false,
}: {
  orgId: string;
  canPair: boolean;
  primary?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirmDevice();
  const [connecting, setConnecting] = useState(false);
  const mine = useThisMac(orgId, connecting);
  const connected = Boolean(mine.data);

  useEffect(() => {
    if (!connecting || !connected) return;
    setConnecting(false);
    toast.show(t("machines.thisMac.connected"));
  }, [connecting, connected, toast, t]);

  if (!inDesktopApp() || mine.isLoading) return null;
  if (connected) {
    return (
      <Button size="sm" icon="drive" onClick={() => void thisMac.openPrefs("folders").catch(() => {})}>
        {t("machines.thisMac.folders")}
      </Button>
    );
  }
  if (!canPair) return null;

  const start = async () => {
    setConnecting(true);
    try {
      const { userCode } = await thisMac.connect(orgId);
      if (userCode) await confirm.mutateAsync({ orgId, userCode });
      void qc.invalidateQueries({ queryKey: THIS_MAC_KEY });
    } catch {
      setConnecting(false);
      toast.show(t("machines.thisMac.failed"), "error");
    }
  };
  return (
    <Button
      size="sm"
      variant={primary ? "primary" : "default"}
      icon="computer"
      loading={connecting}
      onClick={() => void start()}
    >
      {t("machines.thisMac.connect")}
    </Button>
  );
}

/** "Abrir no app": Preferences on `tab`, for what is granted on this Mac itself (folders, tools). */
export function OpenPrefsButton({ tab, children }: { tab: "folders" | "tools"; children: string }) {
  return (
    <Button size="sm" icon="settings" onClick={() => void thisMac.openPrefs(tab).catch(() => {})}>
      {children}
    </Button>
  );
}
