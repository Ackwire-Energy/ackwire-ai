import {
  Button,
  Card,
  Chip,
  Dialog,
  DialogFooter,
  EmptyState,
  Field,
  Icon,
  Input,
  List,
  Menu,
  MenuItem,
  MenuSeparator,
  Spinner,
} from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreatePairing, useMachineAction, useMachines } from "@/api/queries";
import type { Machine, MachineOs, MachinePairing } from "@/api/types";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { errorText } from "@/lib/errors";
import { joinNames, relativeTime } from "@/lib/format";
import { can } from "@/lib/permissions";
import { useToast } from "@/lib/toast";

const OSES: MachineOs[] = ["linux", "darwin", "windows", "other"];
export const osOf = (os: string): MachineOs => (OSES.includes(os as MachineOs) ? (os as MachineOs) : "other");

/** Refetch the list this often while a pairing waits (events usually arrive first). */
const PAIR_POLL_MS = 5000;
/** Flag for files-only machines; shown as is in the steps. */
export const NO_EXEC_FLAG = "--no-exec";

/** "9:41" left until `expiresAt`; null once it passed. */
export function countdown(expiresAt: string, now: number): string | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return null;
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
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
  const seen = m.online
    ? t("machines.seenNow")
    : m.lastSeenAt
      ? t("machines.seen", { when: relativeTime(t, i18n.language, m.lastSeenAt) })
      : t("machines.neverSeen");
  const label = t("machines.actions", { name: m.name });
  return (
    <div className="ac-list__row machine-row">
      <span className="machine-row__icon">
        <Icon name="computer" />
      </span>
      <span className="list-col" style={{ flex: "1 1 260px", minWidth: 0 }}>
        <span className="row" style={{ gap: 8, alignItems: "center" }}>
          <span className="machine-row__name">{m.name}</span>
          <MachineChip online={m.online} />
          {!m.execAllowed && <Chip icon="block">{t("machines.execOff")}</Chip>}
        </span>
        <span className="small muted">
          {t("machines.details", {
            os: t(`machines.os.${osOf(m.os)}`),
            arch: m.arch,
            version: m.runnerVersion,
            seen,
          })}
        </span>
        <span className="small muted">
          {m.pairedBy ? `${t("machines.pairedBy", { name: m.pairedBy.name })} · ` : ""}
          {m.agents.length > 0
            ? t("machines.usedBy", {
                names: joinNames(
                  m.agents.map((a) => a.name),
                  t("newAgent.and"),
                ),
              })
            : t("machines.noAgents")}
        </span>
        {m.workspace && (
          <span className="small muted machine-row__workspace">
            {t("machines.workspace")} <code>{m.workspace}</code>
          </span>
        )}
      </span>
      {m.canManage && (
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
      )}
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
        className="stack-4"
        style={{ gap: 12 }}
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
        <Field label={t("machines.name")} id="machine-rename" error={error ?? undefined}>
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
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

function RemoveDialog({ machine, onClose }: { machine: Machine | null; onClose: () => void }) {
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

/** The install command in a code block, with Copiar. */
function CommandBlock({ command }: { command: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  return (
    <div className="machine-command">
      <pre className="machine-command__code">
        <code>{command}</code>
      </pre>
      <Button
        size="sm"
        variant="ghost"
        icon="copy"
        className="machine-command__copy"
        onClick={async () => {
          try {
            await navigator.clipboard?.writeText(command);
            toast.show(t("machines.commandCopied"));
          } catch {
            toast.show(t("common.unknownError"), "error");
          }
        }}
      >
        {t("common.copy")}
      </Button>
    </div>
  );
}

/**
 * "Conectar um computador": a name → a one-time code and the install
 * command, the time left, short steps, and a live "Conectado" when the
 * runner pairs (`machine.paired` refreshes the list).
 */
export function PairDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const create = useCreatePairing(org.id);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<MachinePairing | null>(null);
  const [known, setKnown] = useState<Set<string>>(new Set());
  const now = useNow(open && pairing !== null);
  const left = pairing ? countdown(pairing.expiresAt, now) : null;
  const machines = useMachines(org.id, open, pairing && left ? PAIR_POLL_MS : false);
  const paired = pairing ? (machines.data ?? []).find((m) => !known.has(m.id)) : undefined;
  useEffect(() => {
    if (open) return;
    setName("");
    setError(null);
    setPairing(null);
    create.reset();
  }, [open, create.reset]);
  const start = () => {
    const clean = name.trim();
    if (!clean) {
      setError(t("machines.nameRequired"));
      return;
    }
    setError(null);
    setKnown(new Set((machines.data ?? []).map((m) => m.id)));
    create.mutate(clean, {
      onSuccess: setPairing,
      onError: (err) => setError(errorText(t, err)),
    });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("machines.pairTitle")}
      description={pairing ? undefined : t("machines.pairText")}
      closeLabel={t("common.close")}
      width={560}
    >
      {!pairing ? (
        <form
          className="stack-4"
          style={{ gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <Field label={t("machines.name")} id="machine-name" help={t("machines.nameHelp")} error={error ?? undefined}>
            <Input
              value={name}
              maxLength={80}
              placeholder={t("machines.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={create.isPending}>
              {t("machines.generate")}
            </Button>
          </DialogFooter>
        </form>
      ) : (
        <div className="stack-4 machine-pair" style={{ gap: 14 }}>
          {paired ? (
            <p className="machine-pair__done" role="status">
              <Icon name="check" />
              <span>{t("machines.connected", { name: paired.name })}</span>
            </p>
          ) : (
            <>
              <p className="small" style={{ margin: 0 }}>
                {t("machines.runThis")}
              </p>
              <CommandBlock command={pairing.installCommand} />
              <p className="small muted tabular" style={{ margin: 0 }}>
                {left
                  ? t("machines.expiresIn", { time: left, code: pairing.code })
                  : t("machines.expired", { code: pairing.code })}
              </p>
              <ol className="machine-pair__steps small">
                <li>{t("machines.step.run")}</li>
                <li>{t("machines.step.noExec", { flag: NO_EXEC_FLAG })}</li>
                <li>{t("machines.step.user")}</li>
              </ol>
              {left && (
                <span className="row small muted" style={{ gap: 8 }} role="status">
                  <Spinner />
                  {t("machines.waiting")}
                </span>
              )}
            </>
          )}
          <DialogFooter>
            {!paired && !left && (
              <Button
                onClick={() => {
                  setPairing(null);
                  create.reset();
                }}
              >
                {t("machines.again")}
              </Button>
            )}
            <Button variant={paired ? "primary" : undefined} onClick={onClose}>
              {paired ? t("machines.done") : t("common.close")}
            </Button>
          </DialogFooter>
        </div>
      )}
    </Dialog>
  );
}

/** Configurações → Computadores: machines connected with the runner; pair, rename, remove. */
export function MachinesSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const machines = useMachines(org.id);
  const canPair = can(org.role, "post");
  const [pairOpen, setPairOpen] = useState(false);
  const [renaming, setRenaming] = useState<Machine | null>(null);
  const [removing, setRemoving] = useState<Machine | null>(null);
  const list = machines.data ?? [];
  const connect = canPair ? (
    <Button size="sm" variant="primary" icon="plus" onClick={() => setPairOpen(true)}>
      {t("machines.connect")}
    </Button>
  ) : null;
  return (
    <>
      <Card aria-labelledby="sec-machines">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div className="stack-4" style={{ gap: 2, flex: "1 1 280px" }}>
            <h2 id="sec-machines" className="ac-card__title">
              {t("machines.title")}
            </h2>
            <span className="small muted">{t("machines.subtitle")}</span>
          </div>
          {list.length > 0 && connect}
        </div>
        {machines.isLoading && <LoadingList count={2} trailing />}
        {machines.isError && !machines.data && (
          <ErrorState error={machines.error} onRetry={() => void machines.refetch()} />
        )}
        {machines.isSuccess && list.length === 0 && (
          <EmptyState icon="computer" title={t("machines.emptyTitle")} actions={connect ?? undefined}>
            {t("machines.emptyText")}
          </EmptyState>
        )}
        {list.length > 0 && (
          <List aria-label={t("machines.title")}>
            {list.map((m) => (
              <MachineRow key={m.id} machine={m} onRename={() => setRenaming(m)} onRemove={() => setRemoving(m)} />
            ))}
          </List>
        )}
      </Card>
      <PairDialog open={pairOpen} onClose={() => setPairOpen(false)} />
      <RenameDialog machine={renaming} onClose={() => setRenaming(null)} />
      <RemoveDialog machine={removing} onClose={() => setRemoving(null)} />
    </>
  );
}
