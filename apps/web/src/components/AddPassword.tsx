import { keys, type Me } from "@agenteschat/client";
import { errorCode, REAUTH_SIGN_IN } from "@agenteschat/client/lib/errors";
import { passwordState } from "@agenteschat/client/lib/text";
import { Alert, Button, Dialog, DialogBody, DialogFooter, Field, Input } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useSignInAgain } from "@/hooks/useSignInAgain";
import { useToast } from "@/lib/toast";
import { PasswordHelp } from "@/pages/AuthPage";

/**
 * "Adicionar uma senha" (Configurações › Sua conta): for an account that signs in another way (Google or Apple, or
 * the agentes.chat app on the computer that runs this server), so it also signs in with its email from
 * any browser. A password proves it's the person, so it needs a sign-in in the last 10 minutes: an older
 * session signs in again first.
 */
export function AddPasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPassword("");
    setError(null);
    setReauth(false);
  }, [open]);
  const save = useMutation({
    mutationFn: () => api.account.addPassword(password),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.me });
      toast.show(t("shell.addPasswordSaved"));
      onClose();
    },
    onError: (e) => {
      const stale = errorCode(e) === REAUTH_SIGN_IN;
      setReauth(stale);
      setError(stale ? t("shell.addPasswordReauth") : e.message);
    },
  });
  const signInAgain = useSignInAgain(qc.getQueryData<Me | null>(keys.me)?.user.email ?? "");
  const ok = passwordState(password) === "ok";
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("shell.addPassword")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !save.isPending) save.mutate();
        }}
      >
        <DialogBody>
          <Field label={t("shell.addPasswordLabel")} id="add-password">
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </Field>
          <PasswordHelp password={password} />
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
            <Button type="submit" variant="primary" disabled={!ok || save.isPending} loading={save.isPending}>
              {t("auth.reset.save")}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
