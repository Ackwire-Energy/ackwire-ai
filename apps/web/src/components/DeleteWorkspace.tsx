import {
  type AccountDeletionPlan,
  keys,
  type Me,
  type OrgSummary,
  useAccountDeletionPlan,
  useApi,
  useAuthConfig,
  useDeleteWorkspace,
} from "@agenteschat/client";
import { computerEdition } from "@agenteschat/client/lib/computer";
import { deletionDueFrom, type ProofNeeded, proofNeeded } from "@agenteschat/client/lib/deletion";
import { errorCode, errorText, REAUTH_PASSWORD, REAUTH_SIGN_IN } from "@agenteschat/client/lib/errors";
import { formatShortDate, formatTime } from "@agenteschat/client/lib/format";
import { sendsEmail } from "@agenteschat/client/lib/join-requests";
import { namesMatch } from "@agenteschat/client/lib/text";
import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  type IconName,
  InfoHint,
  Input,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { saveExport } from "@/components/ImportFlow";
import { useSignInAgain } from "@/hooks/useSignInAgain";
import "./deletion.css";

/**
 * Deleting a workspace (owners): what goes, until when any owner can restore it, its export, its name typed to
 * confirm and the proof that it's them. It closes for everyone at once and goes for good 7 days later; `onDeleted`
 * follows (the closing screen takes the workspace's place by itself).
 */
export function DeleteWorkspaceDialog({
  org,
  open,
  onClose,
  onDeleted = onClose,
}: {
  org: Pick<OrgSummary, "id" | "name">;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const config = useAuthConfig().data;
  const del = useDeleteWorkspace(org.id);
  const proof = useProof(open, errorCode(del.error));
  const [name, setName] = useState("");
  const { reset } = del;
  useEffect(() => {
    if (!open) return;
    setName("");
    reset();
  }, [open, reset]);
  const edition = computerEdition(undefined, config?.workspaceComputer);
  const due = deletionDueFrom();
  const ready = namesMatch(name, org.name) && proof.ready && !del.isPending;
  const submit = () => del.mutate(proof.password || undefined, { onSuccess: onDeleted });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("deleteOrg.title", { name: org.name })}
      description={t("deleteOrg.undo", {
        date: formatShortDate(i18n.language, due),
        time: formatTime(i18n.language, due),
      })}
      closeLabel={t("common.close")}
      width={520}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) submit();
        }}
      >
        <DialogBody>
          <ul className="deletion-lines">
            <DeletionLine icon="message">{t("deleteOrg.goes.content")}</DeletionLine>
            <DeletionLine icon="members">
              {t(sendsEmail(config) ? "deleteOrg.goes.people" : "deleteOrg.goes.peopleQuiet")}
            </DeletionLine>
            {edition && (
              <DeletionLine icon="computer">
                {t(edition === "cloud" ? "deleteOrg.goes.computer" : "deleteOrg.goes.computers")}
              </DeletionLine>
            )}
            <DeletionLine icon="plug">
              <span className="ac-hintline">
                {t("deleteOrg.goes.connectors")}
                <InfoHint name={t("common.about", { label: t("deleteOrg.goes.connectors") })}>
                  {`${t("deleteOrg.bucket")} ${t("deleteOrg.github")}`}
                </InfoHint>
              </span>
            </DeletionLine>
            {config?.billingUrl && <DeletionLine icon="coin">{t("deleteOrg.plan")}</DeletionLine>}
          </ul>
          <p className="small muted deletion-export">
            <Trans
              i18nKey="deleteOrg.export"
              components={{
                export: (
                  <button type="button" className="ac-link ac-link--muted" onClick={() => saveExport(api, org.id)} />
                ),
              }}
            />
          </p>
          {proof.needs === "signIn" ? (
            <SignInNeeded />
          ) : (
            <Field label={t("deleteOrg.type", { name: org.name })}>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          )}
          {proof.needs === "password" && <PasswordProof {...proof.field} />}
          {proof.alert && <Alert>{errorText(t, del.error)}</Alert>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {proof.needs === "signIn" ? (
            <Button type="button" variant="primary" onClick={() => void proof.signInAgain()}>
              {t("proof.signInButton")}
            </Button>
          ) : (
            <Button type="submit" variant="danger" disabled={!ready} loading={del.isPending}>
              {t("deleteOrg.submit")}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** A line of what deleting does, its icon on the text's first line. */
export function DeletionLine({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <li className="ac-iconline">
      <Icon name={icon} size={16} />
      <span>{children}</span>
    </li>
  );
}

/**
 * The proof a deletion takes, while its dialog is `open`: nothing while this session's sign-in is fresh, else the
 * password, else a new sign-in (the preflight says which, and a `reauth.*` refusal, `refused`, overrides it). `ready`
 * once it can be sent; `alert` when the refusal is one only an alert can say.
 */
export function useProof(open: boolean, refused: string | undefined) {
  // Read, not watched: these dialogs stay mounted, and the person is loaded wherever they open.
  const me = useQueryClient().getQueryData<Me | null>(keys.me);
  const plan = useAccountDeletionPlan(open);
  const [password, setPassword] = useState("");
  // A refusal keeps its proof on screen while the next try is on its way.
  const [proven, setProven] = useState<string>();
  useEffect(() => {
    if (refused?.startsWith("reauth.")) setProven(refused);
  }, [refused]);
  useEffect(() => {
    if (!open) return;
    setPassword("");
    setProven(undefined);
  }, [open]);
  // Unread, the preflight leaves it to the account: its password, else a new sign-in.
  const known: Pick<AccountDeletionPlan, "password" | "freshUntil"> | undefined =
    plan.data ?? (plan.isError ? { password: me?.user.hasPassword !== false, freshUntil: null } : undefined);
  const needs: ProofNeeded | null = known ? proofNeeded(known, refused ?? proven) : null;
  const signInAgain = useSignInAgain(me?.user.email ?? "");
  return {
    needs,
    password,
    ready: needs === "none" || (needs === "password" && password !== ""),
    alert: refused !== undefined && refused !== REAUTH_SIGN_IN && refused !== REAUTH_PASSWORD,
    signInAgain,
    field: { value: password, onChange: setPassword, wrong: refused === REAUTH_PASSWORD, signInAgain },
  };
}

/** The password, and signing in again as the other way to prove it's them. */
export function PasswordProof({
  value,
  onChange,
  wrong,
  signInAgain,
}: {
  value: string;
  onChange: (value: string) => void;
  wrong: boolean;
  signInAgain: () => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <div className="deletion-proof">
      <Field label={t("proof.password")} error={wrong ? t("errors.reauth.password") : undefined}>
        <Input
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
      <button type="button" className="ac-link ac-link--muted small" onClick={() => void signInAgain()}>
        {t("proof.signIn")}
      </button>
    </div>
  );
}

/** An account without a password proves it's them with a new sign-in: the footer's button takes them there. */
export function SignInNeeded() {
  const { t } = useTranslation();
  return (
    <p className="ac-iconline deletion-signin">
      <Icon name="lock" size={16} />
      <span>{t("errors.reauth.signIn")}</span>
    </p>
  );
}
