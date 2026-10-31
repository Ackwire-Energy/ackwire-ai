import { type DeletionProofInput, useAccountDeletionPlan, useApi, useAuthConfig, useMe } from "@agenteschat/client";
import { type AccountDeletionLine, accountDeletionLines } from "@agenteschat/client/lib/deletion";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { settingUp } from "@agenteschat/client/lib/guards";
import { Alert, Button, Dialog, DialogBody, DialogFooter, type IconName } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DeletionLine, DeletionProofField, ProofButton, useDeletionProof } from "@/components/DeleteWorkspace";
import { ErrorState, LoadingLine } from "@/components/Loading";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import "./deletion.css";

const LINE_ICON: Record<AccountDeletionLine["kind"], IconName> = {
  closes: "trash",
  leaves: "arrowRight",
  computers: "computer",
  staysBehind: "key",
  messages: "message",
  serverOwner: "settings",
};

/**
 * Deleting my account (the account menu), from its preflight: a workspace that still needs me as its only owner
 * comes first, as a checklist with its two ways out (one still being set up is finished or deleted in its
 * onboarding). Otherwise what closes, what I leave, the computers removed, what stays behind with where to disconnect
 * it, and that my messages stay without my name, then the code emailed to me (or my password, where no email goes)
 * and the button. Deleted: to the sign-in.
 */
export function DeleteAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const config = useAuthConfig().data;
  const me = useMe().data;
  const plan = useAccountDeletionPlan(open);
  const del = useMutation({
    mutationFn: (proof: DeletionProofInput) => api.account.delete(proof),
    meta: { silent: true },
    onSuccess: async () => {
      qc.clear();
      await navigate({ to: "/login" });
      toast.show(t("deleteAccount.deleted"));
    },
    // A workspace that came to need me since the preflight: it shows as a blocker.
    onError: (error) => {
      if (errorCode(error) === "sole_owner") void plan.refetch();
    },
  });
  const proof = useDeletionProof(open, null, del.error);
  const { reset } = del;
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);
  const data = plan.data;
  const blockers = data?.soleOwner ?? [];
  const lines = data ? accountDeletionLines(t, i18n.language, data, { cloud: config?.workspaceComputer === true }) : [];
  const ready = data !== undefined && blockers.length === 0;
  const inSetup = (orgId: string) => me?.organizations.some((o) => o.id === orgId && settingUp(o)) === true;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("deleteAccount.title")}
      closeLabel={t("common.close")}
      width={520}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && proof.ready && !del.isPending) del.mutate(proof.input);
        }}
      >
        <DialogBody>
          {plan.isError ? (
            <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />
          ) : !data ? (
            <LoadingLine width={320} />
          ) : blockers.length > 0 ? (
            <>
              <h3 className="ac-card__title">{t("deleteAccount.blockers")}</h3>
              <ul className="deletion-blockers">
                {blockers.map((o) =>
                  inSetup(o.id) ? (
                    <DeletionLine key={o.id} icon="stageTodo">
                      {t("deleteAccount.soleOwnerSettingUp", { name: o.name })}
                      <span className="deletion-acts">
                        <Link className="ac-link" to="/onboarding">
                          {t("deleteAccount.finishSetup")}
                        </Link>
                        <Link className="ac-link" to="/onboarding" search={{ delete: 1 }}>
                          {t("deleteAccount.deleteOrg", { name: o.name })}
                        </Link>
                      </span>
                    </DeletionLine>
                  ) : (
                    <DeletionLine key={o.id} icon="stageTodo">
                      {t("deleteAccount.soleOwner", { name: o.name })}
                      <span className="deletion-acts">
                        <Link
                          className="ac-link"
                          to="/org/$orgId/settings/$section"
                          params={{ orgId: o.id, section: "members" }}
                        >
                          {t("deleteAccount.openPeople")}
                        </Link>
                        <Link
                          className="ac-link"
                          to="/org/$orgId/settings/$section"
                          params={{ orgId: o.id, section: "general" }}
                          search={{ delete: 1 }}
                        >
                          {t("deleteAccount.deleteOrg", { name: o.name })}
                        </Link>
                      </span>
                    </DeletionLine>
                  ),
                )}
              </ul>
            </>
          ) : (
            <>
              <ul className="deletion-lines">
                {lines.map((line) => (
                  <DeletionLine key={`${line.kind}:${line.text}`} icon={LINE_ICON[line.kind]}>
                    {line.text}
                    {line.links && (
                      <span className="deletion-acts">
                        {line.links.map((l) => (
                          <Link
                            key={l.label}
                            className="ac-link"
                            to="/org/$orgId/settings/$section"
                            params={{ orgId: l.orgId, section: l.section }}
                          >
                            {l.label}
                          </Link>
                        ))}
                      </span>
                    )}
                  </DeletionLine>
                ))}
              </ul>
              <DeletionProofField proof={proof} />
              {proof.alert && errorCode(del.error) !== "sole_owner" && <Alert>{errorText(t, del.error)}</Alert>}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {blockers.length > 0 ? t("common.close") : t("common.cancel")}
          </Button>
          {ready && (
            <ProofButton proof={proof} enabled busy={del.isPending}>
              {t("deleteAccount.submit")}
            </ProofButton>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * "Apagar conta" where there is no account menu: a closed workspace's screen and the onboarding. `trigger` draws the
 * button; the dialog is kept in the address (`?account=delete`), so a sign-in again (adding a password may ask for
 * one) comes back to it.
 */
export function DeleteAccountEntry({ trigger }: { trigger: (open: () => void) => ReactNode }) {
  const [account, setAccount] = useOpenParam("account");
  return (
    <>
      {trigger(() => setAccount("delete"))}
      <DeleteAccountDialog open={account === "delete"} onClose={() => setAccount(null)} />
    </>
  );
}
