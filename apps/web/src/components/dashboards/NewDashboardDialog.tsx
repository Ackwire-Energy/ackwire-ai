import { useAgents, useCreateDashboard } from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Radio,
  RadioGroup,
  Textarea,
} from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { AudienceFields, audienceReady, type BoardAudience } from "./parts";
import "@/pages/dashboards.css";

type Start = "blank" | "agent";

/**
 * New dashboard (ADR 0134 §8, §10): its name; how to start — blank, or asking an agent the person can talk to,
 * which gets the brief in their DM and builds the widgets there; who sees it and who edits it, with the note on what
 * whoever sees it sees. Creating opens the new board.
 */
export function NewDashboardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("dashboards.create.title")}
      description={t("dashboards.create.subtitle")}
      closeLabel={t("common.close")}
      width={620}
      className="db-dialog"
      initialFocus={nameRef}
    >
      {open && <NewDashboardBody nameRef={nameRef} onClose={onClose} />}
    </Dialog>
  );
}

function NewDashboardBody({
  nameRef,
  onClose,
}: {
  nameRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const id = useId();
  const agents = (useAgents(org.id).data ?? []).filter((a) => !a.former && canTalk(a));
  const create = useCreateDashboard(org.id);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState<Start>("blank");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  // Private until the person picks otherwise: nothing reaches others without a choice (ADR 0134 §12).
  const [audience, setAudience] = useState<BoardAudience>({ audience: "private", roleIds: [], editPolicy: "owner" });
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const ready =
    title.trim().length > 0 && audienceReady(audience) && (start === "blank" || (agent && brief.trim().length > 0));
  const submit = () => {
    if (!ready) return;
    create.mutate(
      {
        title: title.trim(),
        audience: audience.audience,
        roleIds: audience.audience === "roles" ? audience.roleIds : [],
        editPolicy: audience.editPolicy,
        ...(start === "agent" && agent ? { start: { agentId: agent.id, brief: brief.trim() } } : {}),
      },
      {
        onSuccess: (board) => {
          const chat = board.startedIn;
          toast.show(
            chat && agent
              ? t("dashboards.create.started", { name: agent.name, title: board.title })
              : t("dashboards.create.created", { title: board.title }),
            "success",
            chat
              ? {
                  label: t("dashboards.create.openChat"),
                  run: () =>
                    void navigate({
                      to: "/org/$orgId/c/$channelId",
                      params: { orgId: org.id, channelId: chat.channelId },
                    }),
                }
              : undefined,
          );
          onClose();
          void navigate({
            to: "/org/$orgId/dashboards/$dashboardId",
            params: { orgId: org.id, dashboardId: board.id },
          });
        },
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  };
  const startOption = (value: Start) => (
    <label
      htmlFor={`${id}-${value}`}
      className="db-opt"
      data-state={start === value ? "checked" : "unchecked"}
      data-disabled={value === "agent" && agents.length === 0 ? "" : undefined}
    >
      <span className="db-opt__icon">
        <Icon name={value === "blank" ? "grid" : "bolt"} size={18} />
      </span>
      <span className="db-opt__text">
        <b>{t(value === "blank" ? "dashboards.create.blank" : "dashboards.create.agent")}</b>
        <small>{t(value === "blank" ? "dashboards.create.blankHint" : "dashboards.create.agentHint")}</small>
      </span>
      <Radio value={value} id={`${id}-${value}`} disabled={value === "agent" && agents.length === 0} />
    </label>
  );
  return (
    <form
      className="db-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <DialogBody className="db-dialog__body">
        <Field label={t("dashboards.create.name")} id={`${id}-name`}>
          <Input
            ref={nameRef}
            value={title}
            maxLength={80}
            placeholder={t("dashboards.create.namePlaceholder")}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <div className="db-f">
          <span className="db-lbl" id={`${id}-start`}>
            {t("dashboards.create.start")}
          </span>
          <RadioGroup className="db-opts" aria-labelledby={`${id}-start`} value={start} onValueChange={setStart}>
            {startOption("blank")}
            {startOption("agent")}
            {start === "agent" && (
              <div className="db-start-agent">
                {/* biome-ignore lint/a11y/useSemanticElements: toggle buttons under a field's label, not a fieldset */}
                <div className="db-agent-chips" role="group" aria-label={t("dashboards.newWidget.who")}>
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="db-agent-chip"
                      aria-pressed={agent?.id === a.id}
                      onClick={() => setAgentId(a.id)}
                    >
                      <AgentAvatar agentId={a.id} name={a.name} size="xs" />
                      <b>{a.name}</b>
                    </button>
                  ))}
                </div>
                <Textarea
                  rows={2}
                  value={brief}
                  maxLength={2000}
                  aria-label={t("dashboards.create.brief", { name: agent?.name ?? "" })}
                  placeholder={t("dashboards.create.briefPlaceholder")}
                  onChange={(e) => setBrief(e.target.value)}
                />
              </div>
            )}
          </RadioGroup>
        </div>
        <AudienceFields value={audience} onChange={setAudience} />
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={!ready} loading={create.isPending}>
          {t("dashboards.create.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
