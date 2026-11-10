import { accountAbout, accountTitle, type ExistingAi } from "@agenteschat/client/lib/ai-accounts";
import { namesText } from "@agenteschat/client/lib/format";
import { type PlanChoice, planOfAccount } from "@agenteschat/client/lib/no-ai";
import { keyLine } from "@agenteschat/client/lib/providers";
import { ProviderLogo, planState, Radio, RadioGroup } from "@agenteschat/ui";
import { type CSSProperties, Fragment, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { planWord } from "@/lib/plan-usage";

/** A row's id in the list: an account's or a key's. */
export const haveId = (r: ExistingAi) => (r.kind === "key" ? `key:${r.key.id}` : `account:${r.choice.login.id}`);

/** How much of its plan an account has used, and whether it is near or at its limit; null where nothing says. */
const room = (r: ExistingAi) => (r.kind === "account" && r.choice.login.usage ? planState(r.choice.login.usage) : null);

/** A row the person can't pick: someone else's they may not use, or a plan that can't run on that computer now. */
const offOf = (r: ExistingAi, dims: (choice: PlanChoice) => boolean) =>
  r.kind === "account" && (r.act === "locked" || dims(planOfAccount(r.choice.login)));

/**
 * A plan that is used in one click first, the one with most room on top (one that doesn't say counts as half used);
 * then one that asks for a sign-in, the workspace's keys, a plan at its limit, and last what can't be picked.
 */
function sorted(rows: readonly ExistingAi[], dims: (choice: PlanChoice) => boolean) {
  const rank = (r: ExistingAi) => {
    const s = room(r);
    const signIn = r.kind === "account" && r.act !== "use" && r.act !== "move";
    return (
      (offOf(r, dims) ? 8000 : 0) +
      (s?.state === "limited" ? 4000 : 0) +
      (r.kind === "key" ? 2000 : 0) +
      (signIn ? 1000 : 0) +
      (s?.used ?? 50)
    );
  };
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

/** The row a list opens on: the usable one with most room, never one at its limit while another has room. */
export function bestHave(rows: readonly ExistingAi[], dims: (choice: PlanChoice) => boolean): string | undefined {
  const first = sorted(rows, dims).find((r) => !offOf(r, dims));
  return first ? haveId(first) : undefined;
}

/** Past this many rows, each group shows its best one and the rest behind "Mostrar mais". */
const ROWS_OPEN = 4;

/**
 * What the person already has for the agent, to pick one and confirm it at the dialog's foot (ADR 0160, addendum):
 * their own accounts first, the workspace's keys, then other people's plans under each owner's name. A row says how
 * near its limit the plan is, in words and as a bar.
 */
export function ConnectHave({
  rows,
  agentName,
  value,
  onChange,
  dims,
  disabled = false,
}: {
  rows: readonly ExistingAi[];
  agentName: string;
  value: string | undefined;
  onChange: (id: string) => void;
  /** A plan that can't sign in on that computer now: its rows are off. */
  dims: (choice: PlanChoice) => boolean;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const dom = useId();
  const [open, setOpen] = useState<string[]>([]);
  const list = sorted(rows, dims);
  const groups: { key: string; label: string; rows: ExistingAi[] }[] = [];
  const into = (key: string, label: string, r: ExistingAi) => {
    const group = groups.find((g) => g.key === key);
    if (group) group.rows.push(r);
    else groups.push({ key, label, rows: [r] });
  };
  for (const r of list) {
    if (r.kind === "account" && r.choice.login.mine) into("mine", t("connectAi.have.title"), r);
  }
  for (const r of list) if (r.kind === "key") into("keys", t("connectAi.key.title"), r);
  for (const r of list) {
    if (r.kind !== "account" || r.choice.login.mine) continue;
    const a = r.choice.login;
    const name = a.ownerName?.split(" ")[0] ?? "";
    into(`owner:${a.ownerId}`, t("agentPage.work.brain.accountOf", { name }), r);
  }
  const folds = rows.length > ROWS_OPEN;
  return (
    <RadioGroup
      className="arrival-have"
      aria-label={t("connectAi.have.title")}
      value={value ?? ""}
      onValueChange={onChange}
    >
      {groups.map((g) => {
        const all = !folds || open.includes(g.key);
        // Folded: its best row, and the one picked.
        const shown = all ? g.rows : g.rows.filter((r, i) => i === 0 || haveId(r) === value);
        return (
          <Fragment key={g.key}>
            <p className="arrival-opts__label">{g.label}</p>
            {shown.map((r) => {
              const id = haveId(r);
              const off = disabled || offOf(r, dims);
              const state = room(r);
              const a = r.kind === "account" ? r.choice.login : undefined;
              // Under its owner's name a row says only how its plan is; one's own says who else thinks with it, two
              // names and how many more (a plan for all of one's agents would name them all).
              const others = a ? [...new Set(a.usedBy)].filter((n) => n !== agentName) : [];
              const about = !a
                ? r.kind === "key"
                  ? keyLine(t, r.key)
                  : undefined
                : !a.mine
                  ? undefined
                  : others.length > 0 && a.shared === true
                    ? t("agentPage.work.brain.accountAlso", { agents: namesText(t, others, 2) })
                    : accountAbout(t, r.choice, agentName);
              const word = a ? planWord(t, i18n.language, a.usage) : null;
              const used = state ? Math.min(100, Math.round(state.used)) : 0;
              return (
                <label
                  key={id}
                  htmlFor={`${dom}-${id}`}
                  className="ac-option arrival-have__row"
                  data-state={id === value ? "checked" : "unchecked"}
                  data-disabled={off ? "" : undefined}
                >
                  <Radio value={id} id={`${dom}-${id}`} disabled={off} />
                  <ProviderLogo id={a ? (a.provider ?? a.kind) : r.kind === "key" ? r.key.provider : ""} size="sm" />
                  <span className="ac-option__text">
                    <span className="ac-option__title">
                      {a ? accountTitle(a) : r.kind === "key" ? r.key.label : ""}
                    </span>
                    {about && <span className="ac-option__desc">{about}</span>}
                    {word && (
                      <span className="ac-option__desc arrival-have__word" data-plan={state?.state}>
                        {word}
                      </span>
                    )}
                  </span>
                  {state && (
                    <span className="arrival-have__room" data-plan={state.state} aria-hidden="true">
                      <span className="arrival-have__pct">
                        {new Intl.NumberFormat(i18n.language, { style: "percent" }).format(used / 100)}
                      </span>
                      <span className="arrival-have__meter">
                        <i style={{ "--used": `${used}%` } as CSSProperties} />
                      </span>
                    </span>
                  )}
                </label>
              );
            })}
            {shown.length < g.rows.length && (
              <button
                type="button"
                className="ac-link ac-link--muted arrival-have__more"
                onClick={() => setOpen((o) => [...o, g.key])}
              >
                {t("folded.more")}
              </button>
            )}
          </Fragment>
        );
      })}
    </RadioGroup>
  );
}
