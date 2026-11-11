import type { ComputerDevice, DeviceStatus, PhoneDevice } from "@agenteschat/client";
import { useDesktopLatest } from "@agenteschat/client";
import { type AudienceIcon, audienceWords, portraitOf, statusLook, statusPill } from "@agenteschat/client/lib/devices";
import { desktopTargetOf, downloadHref } from "@agenteschat/client/lib/machines";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  Avatar,
  Button,
  Chip,
  ComputerPortrait,
  Icon,
  Menu,
  MenuItem,
  PixelSpinner,
  ProviderLogo,
} from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { OrgMark } from "@/components/ProfilePhoto";
import { useDirectory } from "@/hooks/useDirectory";
import "./devices.css";

/** One look per state, the same on every screen: an icon (or the agent's face) and the state's word. */
export function StatusPill({ status }: { status: DeviceStatus }) {
  const { t } = useTranslation();
  const look = statusLook(status);
  const lead =
    status.kind === "in_use" && status.agentId ? (
      <AgentAvatar agentId={status.agentId} name={status.agentName ?? ""} size="xs" />
    ) : look === "busy" || look === "preparing" ? (
      <PixelSpinner size={14} />
    ) : undefined;
  const icon =
    look === "ready"
      ? "check"
      : look === "needs"
        ? "alert"
        : look === "paused"
          ? "pause"
          : look === "offline"
            ? "dash"
            : look === "unsupported"
              ? "block"
              : undefined;
  return (
    <Chip
      className="dv-status"
      data-status={look}
      tone={look === "needs" ? "waiting" : "neutral"}
      icon={lead ? undefined : icon}
      lead={lead}
    >
      {statusPill(t, status)}
    </Chip>
  );
}

/** The pixel portrait at 48 (rows) or 96 (a device's page), in its box so every column lines up. */
export function DevicePortrait({ device, size = 48 }: { device: ComputerDevice | PhoneDevice; size?: 48 | 96 }) {
  const { kind, state } = portraitOf(device);
  return (
    <span className={size === 96 ? "dv-pic dv-pic--page" : "dv-pic"}>
      <ComputerPortrait kind={kind} state={state} size={size} />
    </span>
  );
}

/** Whose it is: a person's face and name, or the workspace's mark for one that belongs to the workspace. */
export function OwnerLine({ device, className }: { device: { ownerUserId: string | null }; className?: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  // A personal workspace names no workspace (ADR 0159): a device of nobody in particular is its person's.
  const owner = useOwner(device.ownerUserId ?? (isPersonal(org) ? me.user.id : null));
  return (
    <span className={className ?? "dv-row__owner"}>
      {owner ? (
        <Avatar kind="person" size="xs" name={owner.name} imageUrl={owner.image} />
      ) : (
        <OrgMark logo={org.logo} size={18} />
      )}
      {owner ? owner.name : t("devices.workspace")}
    </span>
  );
}

export function useOwner(userId: string | null) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return userId ? (dir.memberById.get(userId) ?? null) : null;
}

/**
 * Whose a computer reads as: a workspace one nobody owns, or one an admin marked as the workspace's, shows the
 * workspace (who connected it goes on its page).
 */
export const ownerOf = (d: ComputerDevice) =>
  d.belongsToWorkspace || d.machineKind === "managed" ? null : d.ownerUserId;

/** "Everyone", "Only Sam", "Same as Sam's MacBook Pro", with the audience's icon. */
export function WhoLine({ device, host }: { device: ComputerDevice | PhoneDevice; host?: ComputerDevice | null }) {
  const { t } = useTranslation();
  const owner = useOwner(device.ownerUserId);
  const words = audienceWords(t, {
    audience: device.audience,
    ownerName: owner?.name ?? null,
    belongsToWorkspace: "belongsToWorkspace" in device ? device.belongsToWorkspace : host?.belongsToWorkspace,
    host: host ? { name: host.name, audience: host.audience } : null,
    short: true,
  });
  return (
    <span className="dv-row__who">
      <Icon name={words.icon} size={14} />
      {words.text}
    </span>
  );
}

export const AUDIENCE_ICON: Record<"everyone" | "people" | "owner", AudienceIcon> = {
  everyone: "audienceEveryone",
  people: "audiencePeople",
  owner: "audienceOwner",
};

/** A computer's system as a mark id: Macs, Windows PCs, and every other system as Linux. */
export const osMark = (os: string) => {
  const v = os.toLowerCase();
  if (v === "darwin" || v.startsWith("mac")) return "apple" as const;
  if (v.startsWith("win")) return "windows" as const;
  if (v.startsWith("ubuntu")) return "ubuntu" as const;
  return "linux" as const;
};

/** label over value, in a grid; `wide` spans the row (toolchains). */
export function Facts({ facts }: { facts: { label: string; value: ReactNode; wide?: boolean }[] }) {
  return (
    <dl className="dv-facts">
      {facts.map((f) => (
        <div key={f.label} className={f.wide ? "dv-fact dv-fact--wide" : "dv-fact"}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const SYSTEMS = [
  { target: "darwin", arch: "aarch64", platform: "mac" },
  { target: "windows", arch: "x86_64", platform: "windows" },
  { target: "linux", arch: "x86_64", platform: "linux" },
] as const;

/**
 * "Download for Mac" for the system this page is open on, and a small "Other systems" menu with the other two. A
 * system with no build yet shows disabled with "Em breve"; while its build is asked for, disabled with no mark, so
 * "Em breve" never flashes. A web page can't know whether the app is already installed, so it never says so. A phone
 * shows the menu alone.
 */
export function DownloadButtons({
  primary = false,
  onPick,
}: {
  primary?: boolean;
  /** The system whose download was started (the install steps under it follow it). */
  onPick?: (system: (typeof SYSTEMS)[number]["platform"]) => void;
  /**
   * @deprecated Not used: a system with no build is disabled with "Em breve", and its terminal line is reached from
   * the flow's own link.
   */
  onLine?: (shell: "unix" | "windows") => void;
}) {
  const { t } = useTranslation();
  const here = desktopTargetOf(navigator.userAgent)?.target ?? null;
  const builds = {
    darwin: useDesktopLatest("darwin", "aarch64"),
    windows: useDesktopLatest("windows", "x86_64"),
    linux: useDesktopLatest("linux", "x86_64"),
  };
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const hrefOf = (target: keyof typeof builds) => {
    const url = builds[target].data?.url;
    return url ? downloadHref(url, origin) : null;
  };
  // `null` is the server's answer that there's no build; a failed ask says nothing, so that system isn't offered.
  const soon = (s: (typeof SYSTEMS)[number]) => builds[s.target].data === null;
  const offered = (s: (typeof SYSTEMS)[number]) => !builds[s.target].isError;
  const found = here ? SYSTEMS.find((s) => s.target === here) : undefined;
  const mine = found && offered(found) ? found : undefined;
  const mineHref = mine ? hrefOf(mine.target) : null;
  const others = SYSTEMS.filter((s) => s.target !== mine?.target && offered(s));
  const name = (s: (typeof SYSTEMS)[number]) => t(`machines.os.${s.target}`);
  const soonChip = <Chip icon="lock">{t("common.soon")}</Chip>;
  const variant = primary ? "primary" : "default";
  return (
    <>
      {mine &&
        (mineHref ? (
          <Button asChild size="sm" variant={variant}>
            <a href={mineHref} download onClick={() => onPick?.(mine.platform)}>
              <Icon name="download" />
              {t("devices.downloadFor", { system: name(mine) })}
            </a>
          </Button>
        ) : (
          // Beside the button, not in it: on a narrow screen the mark goes under it instead of past the edge.
          <span className="row">
            <Button size="sm" variant={variant} icon="download" disabled loading={builds[mine.target].isPending}>
              {t("devices.downloadFor", { system: name(mine) })}
            </Button>
            {soon(mine) && soonChip}
          </span>
        ))}
      {others.length > 0 && (
        <Menu
          label={t("devices.otherSystems")}
          trigger={
            <Button size="sm" variant="ghost">
              {mine ? t("devices.otherSystems") : t("devices.downloadApp")}
              <Icon name="chevronDown" />
            </Button>
          }
        >
          {others.map((s) => {
            const href = hrefOf(s.target);
            return (
              <MenuItem
                key={s.target}
                leading={<ProviderLogo id={s.target === "darwin" ? "apple" : s.target} size="xs" off={!href} />}
                disabled={!href}
                hint={soon(s) ? soonChip : undefined}
                onSelect={
                  href
                    ? () => {
                        onPick?.(s.platform);
                        window.location.assign(href);
                      }
                    : undefined
                }
              >
                {t("devices.downloadFor", { system: name(s) })}
              </MenuItem>
            );
          })}
        </Menu>
      )}
    </>
  );
}
