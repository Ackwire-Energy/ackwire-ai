import type { Machine, MachineAccessReduce, MachineOs, MachinePause, MachineToolName } from "@agenteschat/client";
import {
  useAgents,
  useDesktopLatest,
  useDesktopStatus,
  useMachineAction,
  useMachines,
  useReduceMachineAccess,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatBytes } from "@agenteschat/client/lib/files";
import { daysBetween, formatShortDate, formatTime, joinNames, relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  computerKind,
  computerState,
  DESKTOP_TARGET,
  downloadHref,
  folderName,
  installCommand,
  isPaused,
  MACHINE_TOOLS,
} from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Alert,
  AvatarStack,
  Button,
  Card,
  Chip,
  ComputerIcon,
  ComputerPortrait,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Icon,
  Input,
  List,
  Menu,
  MenuItem,
  MenuSeparator,
  ProviderLogo,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingLine, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { OpenPrefsButton, ThisMacButton, useIsThisMac } from "@/components/ThisMac";
import { inDesktopApp } from "@/lib/desktop";
import { useToast } from "@/lib/toast";
import { MachineBrowserCard } from "./browser/MachineBrowserCard";

const OSES: MachineOs[] = ["linux", "darwin", "windows", "other"];
export const osOf = (os: string): MachineOs => (OSES.includes(os as MachineOs) ? (os as MachineOs) : "other");

/** Refetch the list this often while waiting for a new computer (events usually arrive first). */
export const PAIR_POLL_MS = 5000;

/** A connected computer's line icon by its id (its kind from the computers list); the generic one until known. */
export function MachineIcon({ machineId, size = 14 }: { machineId: string | null | undefined; size?: 14 | 16 }) {
  const { org } = useOrg();
  const machines = useMachines(org.id, Boolean(machineId));
  const m = machineId ? machines.data?.find((x) => x.id === machineId) : undefined;
  return m ? <ComputerIcon kind={computerKind(m.os)} size={size} /> : <Icon name="computer" size={size} />;
}

/** Online / Offline, with an icon (never a colored dot). */
export function MachineChip({ online }: { online: boolean }) {
  const { t } = useTranslation();
  return (
    <Chip icon={online ? "check" : "dash"} className="machine-chip">
      {online ? t("machines.online") : t("machines.offline")}
    </Chip>
  );
}

/** "Pausado até 16:24" (another day: "Pausado até 18 out 09:00"), "Pausado"; null when not paused now. */
export function pauseText(t: TFunction, locale: string, paused: MachinePause | null | undefined, now = new Date()) {
  if (!isPaused({ paused }, now.getTime())) return null;
  const until = paused?.until;
  if (!until) return t("machines.paused");
  const time =
    daysBetween(until, now) === 0
      ? formatTime(locale, until)
      : `${formatShortDate(locale, until)} ${formatTime(locale, until)}`;
  return t("machines.pausedUntil", { time });
}

/** The pause the owner set on the machine (ADR 0036 §6), as a chip with an icon. */
export function PausedChip({ paused }: { paused: MachinePause | null | undefined }) {
  const { t, i18n } = useTranslation();
  const text = pauseText(t, i18n.language, paused);
  if (!text) return null;
  return (
    <Chip icon="pause" className="machine-chip">
      {text}
    </Chip>
  );
}

function useCopy() {
  const { t } = useTranslation();
  const toast = useToast();
  return async (text: string, done: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      toast.show(done);
    } catch {
      toast.show(t("common.unknownError"), "error");
    }
  };
}

/** A terminal command in a code block, with Copiar. */
export function CommandBlock({ command }: { command: string }) {
  const { t } = useTranslation();
  const copy = useCopy();
  return (
    <div className="machine-command">
      <pre className="machine-command__code">
        <code>{command}</code>
      </pre>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="copy"
        className="machine-command__copy"
        aria-label={t("common.copy")}
        title={t("common.copy")}
        onClick={() => void copy(command, t("machines.commandCopied"))}
      />
    </div>
  );
}

/**
 * "Baixar o app para Mac" from the latest build, small; nothing while there is none (the connect card says so).
 * In the app itself: "Usar este Mac" instead (ADR 0036).
 */
export function DownloadMacButton({ primary = false }: { primary?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const latest = useDesktopLatest(DESKTOP_TARGET.target, DESKTOP_TARGET.arch);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  if (inDesktopApp()) return <ThisMacButton orgId={org.id} canPair={can(org.role, "post")} primary={primary} />;
  if (!latest.data) return null;
  return (
    <Button asChild size="sm" variant={primary ? "primary" : "default"}>
      <a href={downloadHref(latest.data.url, origin)} download>
        <Icon name="download" />
        {t("machines.download.mac")}
      </a>
    </Button>
  );
}

/**
 * How to connect a computer (ADR 0036 §2, §10): "Baixar o app para Mac" from
 * the latest release (version, size, SHA-256), the first-run steps (the app
 * is signed and notarized), and the terminal installer for servers and Linux. The
 * computer shows a code and the person confirms it on `/conectar`. In the app
 * itself (ADR 0036): "Usar este Mac" in one click instead of the download, unless
 * `download` (connecting another computer from the app).
 */
export function ConnectComputer({ orgId, download = false }: { orgId: string; download?: boolean }) {
  const { t, i18n } = useTranslation();
  const copy = useCopy();
  const latest = useDesktopLatest(DESKTOP_TARGET.target, DESKTOP_TARGET.arch);
  const [other, setOther] = useState(false);
  const otherId = useId();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const release = latest.data ?? null;
  const app = inDesktopApp() && !download;
  return (
    <div className="machine-connect">
      <p className="small muted" style={{ margin: 0 }}>
        {app ? t("machines.thisMac.text") : t("machines.download.text")}
      </p>
      {app ? (
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <ComputerPortrait kind="mac" state="online" />
          <ThisMacButton orgId={orgId} canPair primary />
        </div>
      ) : latest.isLoading ? (
        <LoadingLine width={220} />
      ) : release ? (
        <div className="machine-connect__release">
          <div className="row" style={{ gap: 12, alignItems: "center" }}>
            <ComputerPortrait kind="mac" state="online" />
            <Button asChild variant="primary">
              <a href={downloadHref(release.url, origin)} download>
                <Icon name="download" />
                {t("machines.download.mac")}
              </a>
            </Button>
            <span className="small muted">
              {release.size
                ? t("machines.download.versionSize", {
                    version: release.version,
                    size: formatBytes(i18n.language, release.size),
                  })
                : t("machines.download.version", { version: release.version })}
            </span>
          </div>
          {release.sha256 && (
            <div className="machine-connect__sha">
              <span className="small muted">{t("machines.download.sha")}</span>
              <code className="machine-connect__hash">{release.sha256}</code>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="copy"
                aria-label={t("machines.download.shaCopy")}
                onClick={() => void copy(release.sha256, t("machines.download.shaCopied"))}
              />
            </div>
          )}
          {release.sha256 && <span className="small muted">{t("machines.download.shaHelp")}</span>}
        </div>
      ) : (
        <Alert tone="neutral">{t("machines.download.unavailable")}</Alert>
      )}
      {release && !app && (
        <div className="stack-4" style={{ gap: 6 }}>
          <span className="newag__label">{t("machines.download.firstTime")}</span>
          <ol className="machine-pair__steps small">
            <li>{t("machines.download.step1")}</li>
            <li>{t("machines.download.step2")}</li>
          </ol>
        </div>
      )}
      <div className="machine-connect__other">
        <button
          type="button"
          className="machine-connect__toggle"
          aria-expanded={other}
          aria-controls={otherId}
          onClick={() => setOther((o) => !o)}
        >
          <Icon name={other ? "chevronDown" : "chevronRight"} />
          {t("machines.download.other")}
        </button>
        {other && (
          <div id={otherId} className="stack-4" style={{ gap: 8 }}>
            <p className="small muted" style={{ margin: 0 }}>
              {t("machines.download.otherText")}
            </p>
            <CommandBlock command={installCommand(origin)} />
            <span className="small muted">{t("machines.download.otherNeeds")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function seenText(t: TFunction, locale: string, m: Machine) {
  return m.online
    ? t("machines.seenNow")
    : m.lastSeenAt
      ? t("machines.seen", { when: relativeTime(t, locale, m.lastSeenAt) })
      : t("machines.neverSeen");
}

function MachineMenu({
  machine: m,
  onRename,
  onRemove,
}: {
  machine: Machine;
  onRename: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const label = t("machines.actions", { name: m.name });
  return (
    <Menu
      align="end"
      label={label}
      trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={label} />}
    >
      <MenuItem icon="edit" onSelect={onRename}>
        {t("machines.rename")}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon="trash" danger onSelect={onRemove}>
        {t("machines.remove")}
      </MenuItem>
    </Menu>
  );
}

function MachineRow({
  machine: m,
  onRename,
  onRemove,
}: {
  machine: Machine;
  onRename: () => void;
  onRemove: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const facts = [
    t(`machines.os.${osOf(m.os)}`),
    m.runnerVersion ? t("machines.versionShort", { version: m.runnerVersion }) : null,
    seenText(t, i18n.language, m),
    m.pairedBy ? t("machines.pairedBy", { name: m.pairedBy.name }) : null,
  ].filter(Boolean);
  return (
    <div className="ac-list__row machine-row">
      <ComputerPortrait className="machine-row__icon" kind={computerKind(m.os)} state={computerState(m)} />
      <span className="list-col machine-row__main">
        <span className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Link
            to="/org/$orgId/settings/computers/$machineId"
            params={{ orgId: org.id, machineId: m.id }}
            className="machine-row__name"
            aria-label={t("machines.open", { name: m.name })}
          >
            {m.name}
          </Link>
          <MachineChip online={m.online} />
          <PausedChip paused={m.paused} />
          {!m.execAllowed && <Chip icon="block">{t("machines.execOff")}</Chip>}
        </span>
        <span className="small muted">{facts.join(" · ")}</span>
      </span>
      <span className="machine-row__agents">
        {m.agents.length > 0 ? (
          <span
            className="row"
            style={{ gap: 4 }}
            title={t("machines.usedBy", {
              names: joinNames(
                m.agents.map((a) => a.name),
                t("newAgent.and"),
              ),
            })}
          >
            {m.agents.slice(0, 4).map((a) => (
              <AgentAvatar key={a.id} agentId={a.id} size="sm" name={a.name} />
            ))}
          </span>
        ) : (
          <span className="small muted">{t("machines.noAgents")}</span>
        )}
      </span>
      {m.canManage && <MachineMenu machine={m} onRename={onRename} onRemove={onRemove} />}
    </div>
  );
}

function RenameDialog({ machine, onClose }: { machine: Machine | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useMachineAction(org.id);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(machine?.name ?? "");
    setError(null);
  }, [machine]);
  const clean = name.trim();
  return (
    <Dialog
      open={machine !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("machines.renameTitle")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!machine || !clean) return;
          action.mutate(
            { machineId: machine.id, action: "rename", name: clean },
            {
              onSuccess: () => {
                toast.show(t("machines.renamed", { name: clean }));
                onClose();
              },
              onError: (err) => setError(errorText(t, err)),
            },
          );
        }}
      >
        <DialogBody>
          <Field label={t("machines.name")} id="machine-rename" error={error ?? undefined}>
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!clean || action.isPending} loading={action.isPending}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function RemoveDialog({
  machine,
  onClose,
  onRemoved,
}: {
  machine: Machine | null;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useMachineAction(org.id);
  return (
    <Dialog
      open={machine !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("machines.removeTitle", { name: machine?.name ?? "" })}
      description={t("machines.removeText")}
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          loading={action.isPending}
          disabled={action.isPending}
          onClick={() => {
            if (!machine) return;
            const name = machine.name;
            action.mutate(
              { machineId: machine.id, action: "remove" },
              {
                onSuccess: () => {
                  toast.show(t("machines.removed", { name }));
                  onClose();
                  onRemoved?.();
                },
                onError: (err) => toast.show(errorText(t, err), "error"),
              },
            );
          }}
        >
          {t("machines.remove")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Configurações → Computadores, "Seus computadores":
 * the connected computers (each opens its page) and how to connect one.
 */
export function MachinesSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const machines = useMachines(org.id);
  const canPair = can(org.role, "post");
  const [renaming, setRenaming] = useState<Machine | null>(null);
  const [removing, setRemoving] = useState<Machine | null>(null);
  const list = machines.data ?? [];
  return (
    <>
      <Card aria-labelledby="sec-machines">
        <div className="computers-card__head">
          <span className="computers-card__title">
            <h2 id="sec-machines" className="ac-card__title">
              {t("computers.mine.listTitle")}
            </h2>
            <span className="small muted">{t("computers.mine.listText")}</span>
          </span>
          <DownloadMacButton />
        </div>
        {machines.isLoading && <LoadingList count={2} trailing />}
        {machines.isError && !machines.data && (
          <ErrorState error={machines.error} onRetry={() => void machines.refetch()} />
        )}
        {machines.isSuccess && list.length === 0 && (
          <div className="computers-empty">
            <ComputerPortrait kind="mac" state="offline" size={96} />
            <span className="computers-empty__text">
              <b>{t("computers.mine.emptyTitle")}</b>
              <span className="small muted">
                {inDesktopApp() ? t("machines.thisMac.emptyText") : t("computers.mine.emptyText")}
              </span>
            </span>
          </div>
        )}
        {list.length > 0 && (
          <List aria-label={t("computers.mine.listTitle")}>
            {list.map((m) => (
              <MachineRow key={m.id} machine={m} onRename={() => setRenaming(m)} onRemove={() => setRemoving(m)} />
            ))}
          </List>
        )}
      </Card>
      {canPair && (
        <Card aria-labelledby="sec-machines-connect">
          <h2 id="sec-machines-connect" className="ac-card__title">
            {t("machines.download.title")}
          </h2>
          <ConnectComputer orgId={org.id} />
        </Card>
      )}
      <RenameDialog machine={renaming} onClose={() => setRenaming(null)} />
      <RemoveDialog machine={removing} onClose={() => setRemoving(null)} />
    </>
  );
}

// ── The computer page (Configurações → Computadores → one computer) ──────────

type Reduce =
  | { kind: "folder"; path: string; agent?: { id: string; name: string } }
  | { kind: "tool"; tool: MachineToolName | "browser" };

/** Confirm before taking something away; granting it back only happens on the machine. */
function ReduceDialog({ machine, reduce, onClose }: { machine: Machine; reduce: Reduce | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const mutation = useReduceMachineAccess(org.id);
  let title = "";
  let text = "";
  let done = "";
  let input: MachineAccessReduce = {};
  if (reduce?.kind === "folder") {
    const folder = folderName(reduce.path);
    if (reduce.agent) {
      const values = { folder, name: reduce.agent.name };
      [title, text, done] = [
        t("machines.access.removeAgentTitle", values),
        t("machines.access.removeAgentText", values),
        t("machines.access.removedAgent", values),
      ];
      input = { removeFolder: { path: reduce.path, agentId: reduce.agent.id } };
    } else {
      [title, text, done] = [
        t("machines.access.removeTitle", { folder }),
        t("machines.access.removeText"),
        t("machines.access.removed", { folder }),
      ];
      input = { removeFolder: { path: reduce.path } };
    }
  } else if (reduce?.kind === "tool") {
    const tool = t(`machines.access.tool.${reduce.tool}`);
    [title, text, done] = [
      t("machines.access.disableTitle", { tool }),
      t("machines.access.disableText", { tool }),
      t("machines.access.disabled", { tool }),
    ];
    input = { disableTool: reduce.tool };
  }
  return (
    <Dialog
      open={reduce !== null}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={text}
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          loading={mutation.isPending}
          disabled={mutation.isPending}
          onClick={() =>
            mutation.mutate(
              { machineId: machine.id, ...input },
              {
                onSuccess: () => {
                  toast.show(done);
                  onClose();
                },
                onError: (err) => toast.show(errorText(t, err), "error"),
              },
            )
          }
        >
          {reduce?.kind === "tool" ? t("machines.access.disable") : t("machines.access.remove")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Pastas liberadas: each folder, which agents use it, and (for the owner) Remover. */
function FoldersCard({ machine: m, onReduce }: { machine: Machine; onReduce: (r: Reduce) => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const agents = useAgents(org.id);
  const nameOf = (id: string) =>
    agents.data?.find((a) => a.id === id)?.name ?? m.agents.find((a) => a.id === id)?.name ?? "";
  const access = m.access;
  // This very Mac with an app too old to report: update it from here (agentes for Mac, ADR 0036).
  const here = useIsThisMac(org.id, m.id);
  return (
    <Card aria-labelledby="sec-machine-folders">
      <div className="stack-4" style={{ gap: 2 }}>
        <h2 id="sec-machine-folders" className="ac-card__title">
          {t("machines.access.folders")}
        </h2>
        <span className="small muted">{t("machines.access.foldersText")}</span>
      </div>
      {!access && m.canManage && here ? (
        <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <p className="small muted" style={{ margin: 0, flex: 1, minWidth: 200 }}>
            {t("machines.thisMac.noReport")}
          </p>
          <OpenPrefsButton tab="updates">{t("machines.thisMac.update")}</OpenPrefsButton>
        </div>
      ) : !access ? (
        // The server only shows the folders to admins and whoever connected it.
        <p className="small muted" style={{ margin: 0 }}>
          {m.canManage ? t("machines.access.noReport") : t("machines.access.hidden")}
        </p>
      ) : (
        <List aria-label={t("machines.access.folders")}>
          <div className="ac-list__row machine-folder">
            <span className="machine-row__icon">
              <Icon name="lock" />
            </span>
            <span className="list-col" style={{ flex: "1 1 220px", minWidth: 0 }}>
              <span className="machine-folder__name">{t("machines.access.ownFolder")}</span>
              <span className="small muted">{t("machines.access.ownFolderText")}</span>
            </span>
          </div>
          {access.folders.length === 0 && (
            <div className="ac-list__row machine-folder">
              <span className="small muted">{t("machines.access.noFolders")}</span>
            </div>
          )}
          {access.folders.map((f) => {
            const folder = folderName(f.path);
            const label = t("machines.access.folderActions", { folder });
            return (
              <div key={f.path} className="ac-list__row machine-folder" data-folder={f.path}>
                <span className="machine-row__icon">
                  <Icon name="drive" />
                </span>
                <span className="list-col" style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <span className="machine-folder__name">{folder}</span>
                  <code className="machine-folder__path">{f.path}</code>
                </span>
                {f.agents.length > 0 ? (
                  <span className="machine-folder__agents">
                    <span className="ac-visually-hidden">
                      {t("machines.access.usedBy", { folder })}: {joinNames(f.agents.map(nameOf), t("newAgent.and"))}
                    </span>
                    <AvatarStack aria-hidden="true">
                      {f.agents.map((id) => (
                        <AgentAvatar key={id} agentId={id} size="sm" name={nameOf(id)} />
                      ))}
                    </AvatarStack>
                  </span>
                ) : (
                  <span className="small muted">{t("machines.access.nobody")}</span>
                )}
                {m.canManage && (
                  <Menu
                    align="end"
                    label={label}
                    trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={label} />}
                  >
                    <MenuItem icon="trash" danger onSelect={() => onReduce({ kind: "folder", path: f.path })}>
                      {t("machines.access.removeAll")}
                    </MenuItem>
                    {f.agents.length > 0 && <MenuSeparator />}
                    {f.agents.map((id) => (
                      <MenuItem
                        key={id}
                        icon="close"
                        onSelect={() => onReduce({ kind: "folder", path: f.path, agent: { id, name: nameOf(id) } })}
                      >
                        {t("machines.access.removeAgent", { name: nameOf(id) })}
                      </MenuItem>
                    ))}
                  </Menu>
                )}
              </div>
            );
          })}
        </List>
      )}
    </Card>
  );
}

/** Ferramentas: on/off chips; the owner can turn one off (never on). */
function ToolsCard({ machine: m, onReduce }: { machine: Machine; onReduce: (r: Reduce) => void }) {
  const { t } = useTranslation();
  const access = m.access;
  if (!access) return null;
  return (
    <Card aria-labelledby="sec-machine-tools">
      <div className="stack-4" style={{ gap: 2 }}>
        <h2 id="sec-machine-tools" className="ac-card__title">
          {t("machines.access.tools")}
        </h2>
        <span className="small muted">{t("machines.access.toolsText")}</span>
      </div>
      <List aria-label={t("machines.access.tools")}>
        {MACHINE_TOOLS.map((tool) => {
          const on = access.tools[tool];
          const name = t(`machines.access.tool.${tool}`);
          return (
            <div key={tool} className="ac-list__row machine-tool" data-tool={tool}>
              {tool === "commands" ? (
                <span className="newag__ib">
                  <Icon name="code" size={16} />
                </span>
              ) : (
                <ProviderLogo id={tool} size="sm" off={!on} />
              )}
              <span className="list-col" style={{ flex: "1 1 220px", minWidth: 0 }}>
                <span className="machine-folder__name">{name}</span>
                <span className="small muted">{t(`machines.access.toolText.${tool}`)}</span>
                {tool === "commands" && on && <span className="small muted">{t("machines.access.commandsWarn")}</span>}
              </span>
              <Chip icon={on ? "check" : "dash"}>{on ? t("machines.access.on") : t("machines.access.off")}</Chip>
              {on && m.canManage && (
                <Button
                  size="sm"
                  aria-label={t("machines.access.disableLabel", { tool: name })}
                  onClick={() => onReduce({ kind: "tool", tool })}
                >
                  {t("machines.access.disable")}
                </Button>
              )}
            </div>
          );
        })}
      </List>
    </Card>
  );
}

/** Never a grant button: granting happens on the machine (the app, or the command as a fallback). */
function GrantCard({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // In the app, on this very Mac: straight to Preferences → Pastas (ADR 0036).
  const here = useIsThisMac(org.id, m.id);
  const path = t("machines.access.pathPlaceholder");
  const agent = t("machines.access.agentPlaceholder");
  const allowExample = `agentes-runner folders allow ${path} --agent ${agent}`;
  return (
    <Card aria-labelledby="sec-machine-grant">
      <h2 id="sec-machine-grant" className="ac-card__title">
        {t("machines.access.grantTitle")}
      </h2>
      {m.canManage && here ? (
        <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <p className="small" style={{ margin: 0, flex: 1, minWidth: 200 }}>
            {t("machines.thisMac.grantHere")}
          </p>
          <OpenPrefsButton tab="folders">{t("machines.thisMac.openFolders")}</OpenPrefsButton>
        </div>
      ) : m.canManage ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            {t("machines.access.grantText")}
          </p>
          <span className="small muted">{t("machines.access.grantTerminal")}</span>
          <CommandBlock command={allowExample} />
        </>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          {m.pairedBy
            ? t("machines.access.grantOnlyOwner", { name: m.pairedBy.name })
            : t("machines.page.readOnlyNobody")}
        </p>
      )}
    </Card>
  );
}

/** "Tela ao vivo" beside an agent whose desktop runs on this computer (ADR 0058): its panel on the agent's page. */
function DesktopLink({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const status = useDesktopStatus(org.id, agentId);
  if (!status.data?.running) return null;
  return (
    <Button asChild size="sm" variant="ghost" className="machine-page__screen">
      <Link
        to="/org/$orgId/agents/$agentId"
        params={{ orgId: org.id, agentId }}
        search={{ desktop: 1 }}
        aria-label={t("desktop.machine.seeLabel", agentGrammar(t, name))}
      >
        <Icon name="computer" />
        {t("desktop.machine.see")}
      </Link>
    </Button>
  );
}

/**
 * One connected computer: its state (online, paused), the folders it allows and which
 * agents use each, its tools. The site only shows and reduces; the admins and
 * whoever connected it reduce, everyone else reads.
 */
export function MachinePage({ machineId }: { machineId: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const machines = useMachines(org.id);
  const [renaming, setRenaming] = useState<Machine | null>(null);
  const [removing, setRemoving] = useState<Machine | null>(null);
  const [reduce, setReduce] = useState<Reduce | null>(null);
  const m = machines.data?.find((x) => x.id === machineId);
  const back = (
    <Button asChild size="sm" variant="ghost" className="machine-page__back">
      <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "computers" }} search={{}}>
        <Icon name="chevronLeft" />
        {t("machines.page.back")}
      </Link>
    </Button>
  );
  if (machines.isLoading) return <LoadingList count={2} trailing />;
  if (machines.isError && !machines.data)
    return <ErrorState error={machines.error} onRetry={() => void machines.refetch()} />;
  if (!m) {
    return (
      <>
        {back}
        <Card>
          <EmptyState icon="computer" title={t("machines.page.notFound")}>
            {t("machines.page.notFoundText")}
          </EmptyState>
        </Card>
      </>
    );
  }
  const paused = isPaused(m);
  return (
    <>
      {back}
      <Card aria-labelledby="sec-machine">
        <div className="row machine-page__head">
          <ComputerPortrait
            className="machine-page__icon"
            kind={computerKind(m.os)}
            state={computerState(m)}
            size={96}
          />
          <span className="list-col machine-page__title">
            <h2 id="sec-machine" className="ac-card__title">
              {m.name}
            </h2>
            <span className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <MachineChip online={m.online} />
              <PausedChip paused={m.paused} />
              {m.pairedBy && <Chip icon="person">{t("machines.pairedBy", { name: m.pairedBy.name })}</Chip>}
            </span>
          </span>
          {m.canManage && <MachineMenu machine={m} onRename={() => setRenaming(m)} onRemove={() => setRemoving(m)} />}
        </div>
        <div className="machine-page__facts">
          <span className="small muted">
            {t("machines.details", {
              os: t(`machines.os.${osOf(m.os)}`),
              arch: m.arch,
              version: m.runnerVersion,
              seen: seenText(t, i18n.language, m),
            })}
          </span>
          {paused && <span className="small muted">{t("machines.pausedHint")}</span>}
          {m.workspace && (
            <span className="small muted machine-row__workspace">
              {t("machines.workspace")} <code>{m.workspace}</code>
            </span>
          )}
        </div>
        {m.agents.length > 0 && (
          <div className="stack-4" style={{ gap: 6 }}>
            <span className="newag__label">{t("machines.page.agents")}</span>
            <div className="machine-page__agents">
              {m.agents.map((a) => {
                // What this agent may use here, beyond its own folder (only who may see the access knows).
                const folders = m.access?.folders.filter((f) => f.agents.includes(a.id)).map((f) => folderName(f.path));
                return (
                  <div key={a.id} className="machine-page__agent-row">
                    <Link
                      to="/org/$orgId/agents/$agentId"
                      params={{ orgId: org.id, agentId: a.id }}
                      className="machine-page__agent"
                    >
                      <AgentAvatar agentId={a.id} size="md" name={a.name} />
                      <span className="list-col" style={{ minWidth: 0, flex: 1 }}>
                        <span className="machine-page__agent-name">
                          {a.name} <span className="muted">@{a.handle}</span>
                        </span>
                        {folders && (
                          <span className="small muted">
                            {folders.length > 0
                              ? t("machines.page.agentFolders", { folders: joinNames(folders, t("newAgent.and")) })
                              : t("machines.page.agentOwnFolder")}
                          </span>
                        )}
                      </span>
                      <Icon name="chevronRight" />
                    </Link>
                    {m.online && m.access?.tools.desktop !== false && <DesktopLink agentId={a.id} name={a.name} />}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>
      {!m.canManage && (
        <p className="page__note">
          {m.pairedBy ? t("machines.page.readOnly", { name: m.pairedBy.name }) : t("machines.page.readOnlyNobody")}
        </p>
      )}
      <FoldersCard machine={m} onReduce={setReduce} />
      <ToolsCard machine={m} onReduce={setReduce} />
      <MachineBrowserCard machine={m} onTurnOff={() => setReduce({ kind: "tool", tool: "browser" })} />
      <GrantCard machine={m} />
      <ReduceDialog machine={m} reduce={reduce} onClose={() => setReduce(null)} />
      <RenameDialog machine={renaming} onClose={() => setRenaming(null)} />
      <RemoveDialog
        machine={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() =>
          void navigate({
            to: "/org/$orgId/settings/$section",
            params: { orgId: org.id, section: "computers" },
            search: {},
          })
        }
      />
    </>
  );
}
