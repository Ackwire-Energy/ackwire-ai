import { Chip, Icon, type IconName, Meter } from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLanding } from "./context";
import { AGENT_KEYS, AGENTS, type AgentKey, MODELS, ORG } from "./data";
import { useFormat } from "./format";
import { useVisible } from "./hooks";
import { LpIcon } from "./icons";
import { SampleAgent } from "./LpAvatar";

const CALLS: [AgentKey, string][] = [
  ["lia", MODELS.sonnet],
  ["teo", MODELS.haiku],
  ["bia", MODELS.sonnet],
  ["lia", MODELS.sonnet],
  ["teo", MODELS.haiku],
];
/** Calls already in the ledger on load (not animated). */
const INITIAL_CALLS = 5;
const CAPS: Record<AgentKey, number> = { lia: 50, teo: 30, bia: 25 };

interface Row {
  id: number;
  agent: AgentKey;
  model: string;
  tokens: number;
  cost: number;
}
interface Ledger {
  rows: Row[];
  used: Record<AgentKey, number>;
  total: number;
  tokens: number;
  next: number;
}

/** One more sample model call at the top of the ledger. */
function addCall(l: Ledger): Ledger {
  const [agent, model] = CALLS[l.next % CALLS.length] as [AgentKey, string];
  const haiku = model === MODELS.haiku;
  const tokens = Math.round((haiku ? 900 : 1400) + Math.random() * 2600);
  const cost = tokens * (haiku ? 0.0000015 : 0.000006);
  return {
    rows: [{ id: l.next, agent, model, tokens, cost }, ...l.rows].slice(0, 6),
    used: { ...l.used, [agent]: l.used[agent] + cost },
    total: l.total + cost,
    tokens: l.tokens + tokens,
    next: l.next + 1,
  };
}

function initial(): Ledger {
  let l: Ledger = { rows: [], used: { lia: 31.4, teo: 6.6, bia: 10.12 }, total: 48.12, tokens: 7912430, next: 0 };
  for (let i = 0; i < INITIAL_CALLS; i++) l = addCall(l);
  return l;
}

const POINTS: { icon: IconName; key: "keys" | "scopes" | "owner" }[] = [
  { icon: "lock", key: "keys" },
  { icon: "members", key: "scopes" },
  { icon: "approve", key: "owner" },
];

/** "Controle": the three guarantees and a live usage ledger (a new call every 2.2 s while on screen). */
export function LiveLedger() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { reduced } = useLanding();
  const live = useRef<HTMLDivElement>(null);
  const visible = useVisible(live);
  const [ledger, setLedger] = useState(initial);

  useEffect(() => {
    if (reduced || !visible) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      setLedger(addCall);
    }, 2200);
    return () => clearInterval(id);
  }, [reduced, visible]);

  return (
    <section className="lp-sec lp-sec--flush" id="controle">
      <div className="lp-wrap lp-control">
        <div>
          <div className="lp-sec-head lp-sec-head--flush">
            <span className="lp-eyebrow">{t("landing.control.eyebrow")}</span>
            <h2>{t("landing.control.title")}</h2>
          </div>
          <div className="lp-points">
            {POINTS.map((p) => (
              <div className="lp-pt" key={p.key}>
                <span className="lp-ic">
                  <Icon name={p.icon} />
                </span>
                <div>
                  <b>{t(`landing.control.${p.key}Title`)}</b>
                  <span>{t(`landing.control.${p.key}`)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="lp-live" ref={live}>
          <div className="lp-live-head">
            <LpIcon name="coin" />
            <h3>{t("landing.control.usage", { org: ORG.name, month: fmt.month() })}</h3>
            <Chip icon="bolt">{t("landing.control.live")}</Chip>
          </div>
          <div className="lp-total">
            <b>{fmt.usd(ledger.total)}</b>
            <span>{t("landing.control.tokensMonth", { tokens: fmt.num(ledger.tokens) })}</span>
          </div>
          <div className="lp-budgets">
            {AGENT_KEYS.map((k) => (
              <div className="lp-bud" key={k}>
                <SampleAgent agent={k} size="sm" />
                <b>{AGENTS[k].name}</b>
                <Meter
                  value={Math.min(ledger.used[k], CAPS[k])}
                  max={CAPS[k]}
                  label={t("landing.control.budgetLabel", { agent: AGENTS[k].name })}
                />
                <span className="lp-bud-v">
                  {t("landing.control.budgetOf", { used: fmt.usd(ledger.used[k]), cap: fmt.num(CAPS[k]) })}
                </span>
              </div>
            ))}
          </div>
          <div className="lp-ledger-wrap">
            <table className="lp-ledger">
              <thead>
                <tr>
                  <th>{t("landing.control.agent")}</th>
                  <th>{t("landing.control.model")}</th>
                  <th>{t("landing.control.tokens")}</th>
                  <th>{t("landing.control.cost")}</th>
                </tr>
              </thead>
              <tbody>
                {ledger.rows.map((row) => (
                  <tr key={row.id} className={row.id >= INITIAL_CALLS ? "lp-new" : undefined}>
                    <td className="lp-who">
                      <SampleAgent agent={row.agent} size="xs" />
                      {AGENTS[row.agent].name}
                    </td>
                    <td className="lp-faint">{row.model}</td>
                    <td>{fmt.num(row.tokens)}</td>
                    <td>{fmt.usd(row.cost, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
