import { useSendDm } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Dialog, DialogBody, DialogFooter, Field, Locked, Textarea } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "./org-context";
import "./team-plan.css";

/** The ideas under the field: each fills it with a sentence the person can change (ADR 0159). */
const IDEAS = ["agenda", "money", "training", "studies", "home", "travel"] as const;

/**
 * New agent in a personal workspace (ADR 0159): one question, what it should do, in the person's words. It goes to
 * the right hand as their own message, which proposes the agent on its usual card (Criar, Editar antes); nothing is
 * made before they press it. "Fill everything in" opens the full form.
 */
export function NewAgentAsk({
  open,
  onClose,
  rightHand,
}: {
  open: boolean;
  onClose: () => void;
  rightHand: { id: string; name: string };
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const send = useSendDm(org.id);
  const [what, setWhat] = useState("");
  const g = agentGrammar(rightHand.name);
  const text = what.trim();
  const close = () => {
    if (send.isPending) return;
    setWhat("");
    onClose();
  };
  const create = () =>
    send.mutate(
      { agentId: rightHand.id, body: t("newAgentAsk.message", { what: text }) },
      {
        onSuccess: () => {
          setWhat("");
          onClose();
          void navigate({
            to: "/org/$orgId/dm/agent/$agentId",
            params: { orgId: org.id, agentId: rightHand.id },
          });
        },
      },
    );
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={t("newAgentAsk.title")}
      description={t("newAgentAsk.lead", g)}
      closeLabel={t("common.close")}
      width={520}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (text && !send.isPending) create();
        }}
      >
        <Locked when={send.isPending}>
          <DialogBody>
            <Field label={t("newAgentAsk.field")}>
              <Textarea
                rows={3}
                value={what}
                maxLength={500}
                onChange={(e) => setWhat(e.target.value)}
                placeholder={t("newAgentAsk.placeholder")}
                autoFocus
              />
            </Field>
            {/* biome-ignore lint/a11y/useSemanticElements: a row of suggestion chips, not a native fieldset */}
            <div className="tp-chips__row" role="group" aria-label={t("newAgentAsk.ideas")}>
              {IDEAS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="tp-chip"
                  aria-pressed={what === t(`newAgentAsk.idea.${id}.text`)}
                  onClick={() => setWhat(t(`newAgentAsk.idea.${id}.text`))}
                >
                  {t(`newAgentAsk.idea.${id}.label`)}
                </button>
              ))}
            </div>
          </DialogBody>
        </Locked>
        <DialogFooter
          note={
            <Link
              to="/org/$orgId/agents/new"
              params={{ orgId: org.id }}
              className="ac-link ac-link--muted"
              onClick={close}
            >
              {t("newAgentAsk.full")}
            </Link>
          }
        >
          <Button type="button" onClick={close} disabled={send.isPending}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!text} loading={send.isPending}>
            {t("newAgentAsk.create", g)}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
