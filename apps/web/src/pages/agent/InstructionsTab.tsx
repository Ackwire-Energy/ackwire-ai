import { Button, Card, Diff, diffLines, Icon, Textarea } from "@agenteschat/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProposals } from "@/api/queries";
import { InstructionTips } from "@/components/AgentFields";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { CardHead, useAgentEdit } from "./context";
import { ReadOnlyNote } from "./pieces";

/** Instruções: the text, edited in place (admins); what changed, as a diff; tips to add a line. */
export function InstructionsTab() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const { agent, g, draft, saved, set, can, changeOf, goTo } = useAgentEdit();
  const proposals = useProposals(org.id);
  const [showDiff, setShowDiff] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const editable = can("instructions");
  const changed = Boolean(changeOf("instructions"));
  const pending = (proposals.data ?? []).filter(
    (p) => p.agentId === agent.id && p.status === "pending" && p.target.type === "agent_instructions",
  );
  const helper =
    (agent.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : me.user.name)?.split(/\s+/)[0] ?? me.user.name;
  return (
    <>
      <ReadOnlyNote field="instructions" />
      <div className="agp-cols">
        <div className="agp-col">
          <Card as="section" className="agp-card" data-changed={changed || undefined} aria-labelledby="in-title">
            <CardHead
              id="in-title"
              icon="document"
              title={t("agent.howWorks", g)}
              changeKeys={["instructions"]}
              lock="instructions"
            />
            {editable ? (
              <>
                <Textarea
                  ref={area}
                  className="newag__textarea agp-instructions"
                  rows={14}
                  aria-label={t("agent.instructions")}
                  placeholder={t("newAgent.instructionsPlaceholder")}
                  value={draft.instructions}
                  onChange={(e) => set("instructions", e.target.value)}
                />
                <div className="newag__ta-meta">
                  <span className="small muted">{t("agent.instructionsHelp", { org: org.name })}</span>
                  <span className="newag__count ac-num">
                    <span aria-hidden="true">{draft.instructions.length}</span>
                    <span className="ac-visually-hidden">
                      {t("newAgent.characters", { count: draft.instructions.length })}
                    </span>
                  </span>
                </div>
                {changed && (
                  <div className="agp-stack">
                    <Button
                      size="sm"
                      className="agp-self-start"
                      aria-expanded={showDiff}
                      onClick={() => setShowDiff((v) => !v)}
                    >
                      {showDiff ? t("agentPage.instructions.hideDiff") : t("agentPage.instructions.showDiff")}
                    </Button>
                    {showDiff && (
                      <Diff
                        aria-label={t("agentPage.instructions.diff")}
                        addedLabel={t("proposals.added")}
                        removedLabel={t("proposals.removed")}
                        lines={diffLines(saved.instructions.split("\n"), draft.instructions.split("\n"))}
                      />
                    )}
                  </div>
                )}
              </>
            ) : agent.instructions.trim() ? (
              <p className="agp-prose">{agent.instructions}</p>
            ) : (
              <p className="muted">{t("agent.noInstructions", g)}</p>
            )}
          </Card>
        </div>
        <div className="agp-col">
          {editable && (
            <Card as="section" className="agp-card" aria-labelledby="in-add">
              <CardHead id="in-add" icon="plus" title={t("agentPage.instructions.add")} />
              <InstructionTips
                helper={helper}
                onAdd={(line) => {
                  const v = draft.instructions;
                  set("instructions", (v.trim() ? `${v.replace(/\s+$/, "")}\n` : "") + line);
                  setTimeout(() => {
                    const ta = area.current;
                    ta?.focus();
                    ta?.setSelectionRange?.(ta.value.length, ta.value.length);
                  });
                }}
              />
            </Card>
          )}
          <p className="newag__note">
            <Icon name="info" size={16} />
            <span>{t("newAgent.contextNote", { ...g, org: org.name })}</span>
          </p>
          {pending.length > 0 && (
            <div className="agp-attn">
              <span className="agp-ib agp-ib--warn">
                <Icon name="document" size={16} />
              </span>
              <span className="agp-attn__t">
                <b>{t("agentPage.instructions.proposals", { count: pending.length })}</b>
                <span>{t("agentPage.overview.proposes", g)}</span>
              </span>
              <Button size="sm" onClick={() => goTo("memory")}>
                {t("agentPage.overview.review")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
