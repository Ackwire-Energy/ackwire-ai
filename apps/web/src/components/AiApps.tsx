import type { AppAccess, AppsList, ConnectedApp, Me, PersonalToken, PersonalTokenInput } from "@agenteschat/client";
import { ApiError, keys, useAppActions, useApps } from "@agenteschat/client";
import {
  APP_CLIENTS,
  type AppClientId,
  claudeCodeCommand,
  codexCommands,
  cursorConfig,
  cursorInstallLink,
  OTHER_CLIENT_TABS,
  type OtherClientTab,
  vscodeConfig,
  vscodeInstallLink,
} from "@agenteschat/client/lib/app-clients";
import { appFacts, appMark, isAppsEmpty, newlyConnected, tokenFacts } from "@agenteschat/client/lib/apps";
import { errorCode, errorText, REAUTH_SIGN_IN } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Alert,
  Button,
  Card,
  Chip,
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
  OptionList,
  PixelSpinner,
  ProviderLogo,
  Select,
  SettingNote,
  TabPanel,
  Tabs,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { HelpLink } from "@/components/HelpLink";
import { ErrorState, LoadingList } from "@/components/Loading";
import { CommandBlock } from "@/components/Machines";
import { useOrg } from "@/components/org-context";
import { useSignInAgain } from "@/hooks/useSignInAgain";
import { useToast } from "@/lib/toast";
import "./ai-apps.css";

/** How long the connect dialog keeps checking for the new app, and how often. */
const WATCH_MS = 10 * 60_000;
const POLL_MS = 5_000;

const CODE = { code: <code /> };

/** An app's face: its brand's mark from a verified address, the computer for a local program, or its initial. */
export function AppMark({
  app,
  size = "sm",
}: {
  app: { brand: string | null; displayKind: string; name: string };
  size?: "xs" | "sm" | "tile";
}) {
  const mark = appMark(app);
  if (mark.kind === "brand") return <ProviderLogo id={mark.id} size={size} />;
  return (
    <span className={`ac-brand ac-brand--${size} ac-brand--mono`} aria-hidden="true">
      {mark.kind === "computer" ? <Icon name="computer" /> : <span className="ac-brand__initial">{mark.letter}</span>}
    </span>
  );
}

type Confirm = { kind: "app"; item: ConnectedApp } | { kind: "token"; item: PersonalToken };

/**
 * Configurações → Apps de IA (ADR 0113): this server's address, "Conectar um app" with each app's steps, the apps
 * connected here and the personal tokens. Who manages members also sees everyone's, and disconnects any.
 */
export function AiAppsSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "manage_members");
  const [view, setView] = useState<"mine" | "all">("mine");
  const list = useApps(org.id, view === "all");
  const [connecting, setConnecting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const data = list.data;
  const body = (
    <AppsBody
      list={list.data}
      loading={list.isLoading}
      error={list.isError && !list.data ? list.error : null}
      onRetry={() => void list.refetch()}
      whole={view === "all"}
      onCreate={() => setCreating(true)}
      onConfirm={setConfirm}
    />
  );
  return (
    <>
      <Card aria-labelledby="apps-server" className="apps-server">
        <div className="apps-server__head">
          <span className="list-col">
            <h2 id="apps-server" className="ac-card__title">
              {t("apps.server")}
            </h2>
            <span className="small muted">{t("apps.serverHelp")}</span>
          </span>
          <Button variant="primary" icon="plus" onClick={() => setConnecting(true)}>
            {t("apps.connect")}
          </Button>
        </div>
        {data ? <CommandBlock command={data.serverUrl} copied={t("apps.serverCopied")} /> : <LoadingList count={1} />}
      </Card>
      {admin ? (
        <Tabs
          value={view}
          onValueChange={setView}
          label={t("apps.view.label")}
          items={[
            { value: "mine", label: t("apps.view.mine") },
            { value: "all", label: t("apps.view.all") },
          ]}
        >
          <TabPanel value="mine">{view === "mine" && body}</TabPanel>
          <TabPanel value="all">{view === "all" && body}</TabPanel>
        </Tabs>
      ) : (
        body
      )}
      <p className="page__note">
        {t("apps.footer")} <HelpLink slug="apps-de-ia">{t("apps.help")}</HelpLink>
      </p>
      {connecting && data && (
        <ConnectAppDialog
          serverUrl={data.serverUrl}
          seen={data.apps.map((a) => a.id)}
          onClose={() => setConnecting(false)}
          onToken={() => {
            setConnecting(false);
            setCreating(true);
          }}
        />
      )}
      {creating && <TokenDialog onClose={() => setCreating(false)} />}
      <ConfirmDialog confirm={confirm} whole={view === "all"} onClose={() => setConfirm(null)} />
    </>
  );
}

function AppsBody({
  list,
  loading,
  error,
  onRetry,
  whole,
  onCreate,
  onConfirm,
}: {
  list: AppsList | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  whole: boolean;
  onCreate: () => void;
  onConfirm: (c: Confirm) => void;
}) {
  const { t } = useTranslation();
  if (loading) return <LoadingList count={2} trailing />;
  if (error || !list) return <ErrorState error={error} onRetry={onRetry} />;
  return (
    <>
      {isAppsEmpty(list) && !whole ? (
        <EmptyState icon="link">{t("apps.empty")}</EmptyState>
      ) : (
        list.apps.length > 0 && (
          <Card aria-labelledby="apps-connected">
            <h2 id="apps-connected" className="ac-card__title">
              {t("apps.connected")}
            </h2>
            <List aria-label={t("apps.connected")}>
              {list.apps.map((app) => (
                <AppRow key={app.id} app={app} onDisconnect={() => onConfirm({ kind: "app", item: app })} />
              ))}
            </List>
          </Card>
        )
      )}
      <Card aria-labelledby="apps-tokens">
        <div className="apps-server__head">
          <span className="list-col">
            <h2 id="apps-tokens" className="ac-card__title">
              {t("apps.tokens.title")}
            </h2>
            <span className="small muted">{t("apps.tokens.text")}</span>
          </span>
          {!whole && (
            <Button icon="key" onClick={onCreate}>
              {t("apps.tokens.create")}
            </Button>
          )}
        </div>
        {list.tokens.length > 0 ? (
          <List aria-label={t("apps.tokens.title")}>
            {list.tokens.map((token) => (
              <TokenRow key={token.id} token={token} onRevoke={() => onConfirm({ kind: "token", item: token })} />
            ))}
          </List>
        ) : (
          <SettingNote icon="key" quiet>
            {t("apps.tokens.empty")}
          </SettingNote>
        )}
      </Card>
    </>
  );
}

function AppRow({ app, onDisconnect }: { app: ConnectedApp; onDisconnect: () => void }) {
  const { t, i18n } = useTranslation();
  const facts = appFacts(t, i18n.language, app);
  return (
    <div className="ac-list__row app-row">
      <AppMark app={app} />
      <span className="list-col app-row__main">
        <span className="app-row__title">
          <span className="app-row__name">{app.name}</span>
          <AccessChip access={app.access} />
        </span>
        <span className="small muted">{facts}</span>
      </span>
      <RowMenu name={app.name} label={t("apps.disconnect")} onSelect={onDisconnect} />
    </div>
  );
}

function TokenRow({ token, onRevoke }: { token: PersonalToken; onRevoke: () => void }) {
  const { t, i18n } = useTranslation();
  const facts = tokenFacts(t, i18n.language, token);
  return (
    <div className="ac-list__row app-row">
      <span className="ac-brand ac-brand--sm ac-brand--mono" aria-hidden="true">
        <Icon name="key" />
      </span>
      <span className="list-col app-row__main">
        <span className="app-row__title">
          <span className="app-row__name">{token.name}</span>
          <AccessChip access={token.access} />
        </span>
        <span className="small muted">{facts}</span>
      </span>
      <RowMenu name={token.name} label={t("apps.tokens.revoke")} onSelect={onRevoke} />
    </div>
  );
}

function AccessChip({ access }: { access: AppAccess }) {
  const { t } = useTranslation();
  return <Chip icon={access === "write" ? "send" : "eye"}>{t(`apps.access.${access}`)}</Chip>;
}

function RowMenu({ name, label, onSelect }: { name: string; label: string; onSelect: () => void }) {
  const { t } = useTranslation();
  const menu = t("apps.actions", { name });
  return (
    <Menu
      align="end"
      label={menu}
      trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={menu} />}
    >
      <MenuItem icon="block" danger onSelect={onSelect}>
        {label}
      </MenuItem>
    </Menu>
  );
}

/** Desconectar an app or Revogar a token: it loses access at once. */
function ConfirmDialog({ confirm, whole, onClose }: { confirm: Confirm | null; whole: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useAppActions(org.id);
  const app = confirm?.kind === "app";
  const mutation = app ? actions.disconnect : actions.revokeToken;
  const name = confirm?.item.name ?? "";
  const someoneElse = whole && !!confirm?.item.person;
  return (
    <Dialog
      open={confirm !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t(app ? "apps.disconnectTitle" : "apps.tokens.revokeTitle", { name })}
      description={
        <>
          {t(app ? "apps.disconnectText" : "apps.tokens.revokeText")}
          {someoneElse && ` ${t("apps.notNotified")}`}
        </>
      }
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
            confirm &&
            mutation.mutate(confirm.item.id, {
              onSuccess: () => {
                toast.show(app ? t("apps.disconnected", { name }) : t("apps.tokens.revoked"));
                onClose();
              },
            })
          }
        >
          {app ? t("apps.disconnect") : t("apps.tokens.revoke")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ── "Conectar um app" ─────────────────────────────────────────────────────────

/**
 * One card per app, then that app's steps in the same dialog with the address to paste. While the steps are open
 * the list is asked again every few seconds: the new app shows here once its sign-in is done.
 */
export function ConnectAppDialog({
  serverUrl,
  seen,
  onClose,
  onToken,
}: {
  serverUrl: string;
  seen: string[];
  onClose: () => void;
  onToken: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [client, setClient] = useState<AppClientId | null>(null);
  const [known] = useState(() => new Set(seen));
  const [watching, setWatching] = useState(false);
  const list = useApps(org.id, false, watching ? POLL_MS : false);
  const connected = client ? newlyConnected(list.data, known) : null;
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!client || connected || timedOut) {
      setWatching(false);
      return;
    }
    setWatching(true);
    const timer = setTimeout(() => setTimedOut(true), WATCH_MS);
    return () => clearTimeout(timer);
  }, [client, connected, timedOut]);
  const picked = APP_CLIENTS.find((c) => c.id === client);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={picked ? t(`apps.dialog.client.${picked.id}`) : t("apps.connect")}
      description={picked ? undefined : t("apps.dialog.pick")}
      leading={picked ? <ClientMark mark={picked.mark} /> : undefined}
      closeLabel={t("common.close")}
      width={560}
      className="apps-connect"
    >
      <DialogBody className="apps-connect__body">
        {!picked ? (
          <div className="apps-clients">
            {APP_CLIENTS.map((c) => (
              <button key={c.id} type="button" className="apps-client" onClick={() => setClient(c.id)}>
                <ClientMark mark={c.mark} />
                <span className="list-col">
                  <span className="apps-client__name">{t(`apps.dialog.client.${c.id}`)}</span>
                  <span className="small muted">{t(`apps.dialog.clientText.${c.id}`)}</span>
                </span>
                <Icon name="chevronRight" size={16} className="apps-client__go" />
              </button>
            ))}
          </div>
        ) : connected ? (
          <div className="apps-connected" role="status">
            <AppMark app={connected} size="tile" />
            <span className="list-col">
              <b className="apps-connected__title">
                <Icon name="check" size={16} />
                {t("apps.dialog.connected", { name: connected.name })}
              </b>
              <span className="small muted">{t("apps.dialog.connectedText")}</span>
            </span>
          </div>
        ) : (
          <>
            <ClientSteps client={picked.id} app={picked.app} url={serverUrl} onToken={onToken} />
            {timedOut ? (
              <div className="apps-watch apps-watch--late">
                <span className="small muted">{t("apps.dialog.timeout")}</span>
                <Button
                  size="sm"
                  icon="refresh"
                  loading={list.isFetching}
                  onClick={() => {
                    setTimedOut(false);
                    void list.refetch();
                  }}
                >
                  {t("apps.dialog.check")}
                </Button>
              </div>
            ) : (
              <p className="apps-watch small muted" role="status">
                <PixelSpinner size={14} />
                {t("apps.dialog.waiting")}
              </p>
            )}
          </>
        )}
      </DialogBody>
      {picked && (
        <DialogFooter>
          {connected ? (
            <Button variant="primary" onClick={onClose}>
              {t("apps.dialog.done")}
            </Button>
          ) : (
            <Button
              icon="chevronLeft"
              onClick={() => {
                setClient(null);
                setTimedOut(false);
              }}
            >
              {t("apps.dialog.back")}
            </Button>
          )}
        </DialogFooter>
      )}
    </Dialog>
  );
}

function ClientMark({ mark }: { mark: string | null }) {
  if (mark) return <ProviderLogo id={mark} size="sm" />;
  return (
    <span className="ac-brand ac-brand--sm ac-brand--mono" aria-hidden="true">
      <Icon name="plug" />
    </span>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="machine-pair__steps apps-steps small">{children}</ol>;
}

function OpenLink({ href, app }: { href: string; app: string }) {
  const { t } = useTranslation();
  return (
    <Button asChild size="sm">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <Icon name="external" />
        {t("apps.dialog.open", { app })}
      </a>
    </Button>
  );
}

/** One app's steps, each fact from `app-clients.ts`. */
function ClientSteps({
  client,
  app,
  url,
  onToken,
}: {
  client: AppClientId;
  app: string | undefined;
  url: string;
  onToken: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<OtherClientTab>("vscode");
  const address = <CommandBlock command={url} copied={t("apps.serverCopied")} />;
  if (client === "claude") {
    return (
      <>
        <p className="small muted apps-lead">{t("apps.dialog.claude.lead")}</p>
        <Steps>
          <li>
            <span className="apps-step">
              {t("apps.dialog.claude.step1")}
              {app && <OpenLink href={app} app="Claude" />}
            </span>
          </li>
          <li>
            <span className="apps-step">
              {t("apps.dialog.claude.step2")}
              {address}
            </span>
          </li>
          <li>{t("apps.dialog.claude.step3")}</li>
        </Steps>
        <SettingNote icon="phone">{t("apps.dialog.claude.phone")}</SettingNote>
        <SettingNote icon="members">{t("apps.dialog.claude.team")}</SettingNote>
      </>
    );
  }
  if (client === "claude_code") {
    return (
      <>
        <Steps>
          <li>
            <span className="apps-step">
              {t("apps.dialog.claudeCode.step1")}
              <CommandBlock command={claudeCodeCommand(url)} />
            </span>
          </li>
          <li>
            <span>
              <Trans i18nKey="apps.dialog.claudeCode.step2" components={CODE} />
            </span>
          </li>
        </Steps>
        <SettingNote icon="info">
          <Trans i18nKey="apps.dialog.claudeCode.scope" components={CODE} />
        </SettingNote>
      </>
    );
  }
  if (client === "chatgpt") {
    return (
      <>
        <Steps>
          <li>
            <span className="apps-step">
              {t("apps.dialog.chatgpt.step1")}
              {app && <OpenLink href={app} app="ChatGPT" />}
            </span>
          </li>
          <li>{t("apps.dialog.chatgpt.step2")}</li>
          <li>
            <span className="apps-step">
              {t("apps.dialog.chatgpt.step3")}
              {address}
            </span>
          </li>
        </Steps>
        <SettingNote icon="info">{t("apps.dialog.chatgpt.plans")}</SettingNote>
      </>
    );
  }
  if (client === "cursor") {
    return (
      <>
        <div className="row">
          <Button asChild variant="primary">
            <a href={cursorInstallLink(url)}>{t("apps.dialog.cursor.add")}</a>
          </Button>
        </div>
        <span className="apps-step small muted">
          <span>
            <Trans i18nKey="apps.dialog.cursor.manual" components={CODE} />
          </span>
          <CommandBlock command={cursorConfig(url)} />
        </span>
        <SettingNote icon="info">{t("apps.dialog.cursor.signIn")}</SettingNote>
      </>
    );
  }
  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      label={t("apps.dialog.other.tabs")}
      items={OTHER_CLIENT_TABS.map((value) => ({ value, label: t(`apps.dialog.other.${value}`) }))}
    >
      <TabPanel value="vscode">
        <div className="row">
          <Button asChild variant="primary">
            <a href={vscodeInstallLink(url)}>{t("apps.dialog.other.vscodeAdd")}</a>
          </Button>
        </div>
        <span className="apps-step small muted">
          <span>
            <Trans i18nKey="apps.dialog.other.vscodeManual" components={CODE} />
          </span>
          <CommandBlock command={vscodeConfig(url)} />
        </span>
      </TabPanel>
      <TabPanel value="codex">
        <span className="apps-step small muted">
          {t("apps.dialog.other.codexStep")}
          <CommandBlock command={codexCommands(url)} />
        </span>
      </TabPanel>
      <TabPanel value="any">
        <span className="apps-step small muted">
          {t("apps.dialog.other.anyStep")}
          {address}
        </span>
        <SettingNote icon="key">{t("apps.dialog.other.anyToken")}</SettingNote>
        <div className="row">
          <Button size="sm" icon="key" onClick={onToken}>
            {t("apps.dialog.other.toTokens")}
          </Button>
        </div>
      </TabPanel>
    </Tabs>
  );
}

// ── Personal tokens ───────────────────────────────────────────────────────────

type Validity = "30" | "90" | "365" | "none";
const VALIDITIES: Validity[] = ["30", "90", "365", "none"];
const daysOf = (v: Validity): PersonalTokenInput["expiresInDays"] =>
  v === "none" ? null : (Number(v) as 30 | 90 | 365);

/** "Criar token": a name, the access and how long it lasts; then the token once, closed only after copying it. */
export function TokenDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { createToken } = useAppActions(org.id);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<AppAccess>("write");
  const [validity, setValidity] = useState<Validity>("90");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const qc = useQueryClient();
  const signInAgain = useSignInAgain(qc.getQueryData<Me | null>(keys.me)?.user.email ?? "");
  if (secret) {
    return (
      <Dialog
        open
        // ×, Esc or a press outside before copying would lose the token for good: they ask first.
        onOpenChange={(o) => {
          if (o) return;
          if (copied) onClose();
          else setLeaving(true);
        }}
        title={t("apps.tokens.createdTitle")}
        closeLabel={t("common.close")}
        width={520}
      >
        <DialogBody className="apps-token">
          <Alert tone="neutral">{t("apps.tokens.once")}</Alert>
          <CommandBlock
            command={secret}
            copied={t("apps.tokens.copied")}
            copyLabel={t("apps.tokens.copy")}
            onCopied={() => setCopied(true)}
          />
          <SettingNote icon="info">{t("apps.tokens.use")}</SettingNote>
          {leaving && !copied && <Alert>{t("apps.tokens.leaveText")}</Alert>}
        </DialogBody>
        <DialogFooter>
          {leaving && !copied && (
            <Button variant="danger" onClick={onClose}>
              {t("apps.tokens.leave")}
            </Button>
          )}
          <Button variant="primary" disabled={!copied} onClick={onClose}>
            {t("apps.tokens.done")}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }
  const clean = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("apps.tokens.create")}
      description={t("apps.tokens.text")}
      closeLabel={t("common.close")}
      width={520}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!clean || createToken.isPending) return;
          setError(null);
          setReauth(false);
          createToken.mutate(
            { name: clean, access, expiresInDays: daysOf(validity) },
            {
              onSuccess: (created) => setSecret(created.secret),
              onError: (err) => {
                const stale = errorCode(err) === REAUTH_SIGN_IN;
                setReauth(stale);
                setError(
                  stale
                    ? t("apps.tokens.reauth")
                    : err instanceof ApiError && err.code === "token_limit"
                      ? t("apps.tokens.limit")
                      : errorText(t, err),
                );
              },
            },
          );
        }}
      >
        <DialogBody className="apps-token">
          <Field label={t("apps.tokens.name")} id="apps-token-name">
            <Input
              value={name}
              maxLength={60}
              placeholder={t("apps.tokens.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="apps-field" style={{ gap: 6 }}>
            <span className="newag__label" id="apps-token-access">
              {t("apps.tokens.access")}
            </span>
            <OptionList
              aria-labelledby="apps-token-access"
              value={access}
              onValueChange={setAccess}
              options={[
                { value: "write", title: t("apps.consent.write"), description: t("apps.consent.writeHelp") },
                { value: "read", title: t("apps.consent.read"), description: t("apps.consent.readHelp") },
              ]}
            />
          </div>
          <Field label={t("apps.tokens.validity")} id="apps-token-validity">
            <Select
              value={validity}
              onValueChange={(v) => {
                setValidity(v as Validity);
                setReauth(false);
                setError(null);
              }}
              options={VALIDITIES.map((v) => ({ value: v, label: t(`apps.tokens.days.${v}`) }))}
            />
          </Field>
          {error && <Alert>{error}</Alert>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {reauth ? (
            <Button type="button" variant="primary" onClick={() => void signInAgain()}>
              {t("proof.signInButton")}
            </Button>
          ) : (
            <Button type="submit" variant="primary" loading={createToken.isPending} disabled={!clean}>
              {t("apps.tokens.create")}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
