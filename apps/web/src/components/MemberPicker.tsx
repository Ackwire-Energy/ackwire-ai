import { Avatar, Checkbox } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useOrg } from "./org-context";

export type PickKey = `person:${string}` | `agent:${string}`;

export interface PickRow {
  key: PickKey;
  kind: "person" | "agent";
  id: string;
  name: string;
  sub: string;
}

/** People and agents of the org as pickable rows, minus `exclude`, filtered by `query`. */
export function useMemberRows(query: string, exclude: Set<PickKey> = new Set()) {
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const q = query.trim().toLowerCase();
  const rows: PickRow[] = [
    ...dir.members
      .filter((m) => m.userId !== me.user.id)
      .map((m) => ({
        key: `person:${m.userId}` as PickKey,
        kind: "person" as const,
        id: m.userId,
        name: m.name,
        sub: m.email,
      })),
    ...dir.agents.map((a) => ({
      key: `agent:${a.id}` as PickKey,
      kind: "agent" as const,
      id: a.id,
      name: a.name,
      sub: `@${a.handle}`,
    })),
  ];
  return rows.filter((r) => !exclude.has(r.key) && (!q || `${r.name} ${r.sub}`.toLowerCase().includes(q)));
}

/** Searchable list rows with our checkbox (used inside a DialogSearchList). */
export function MemberPickerRows({
  rows,
  selected,
  onToggle,
}: {
  rows: PickRow[];
  selected: Set<PickKey>;
  onToggle: (key: PickKey, on: boolean) => void;
}) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const { t } = useTranslation();
  return (
    <>
      {rows.map((r) => {
        const id = `pick-${r.key.replace(/[^a-zA-Z0-9]/g, "-")}`;
        return (
          <label key={r.key} htmlFor={id} className="scope-row">
            <Checkbox id={id} checked={selected.has(r.key)} onCheckedChange={(on) => onToggle(r.key, on)} />
            <Avatar
              kind={r.kind}
              size="sm"
              name={r.name}
              initials={r.kind === "agent" ? dir.agentInitials(r.id) : undefined}
            />
            <span className="scope-row__text">
              <span>{r.name}</span>
              <span className="small muted">
                {r.kind === "agent" ? `${t("channelMembers.agents")} · ${r.sub}` : r.sub}
              </span>
            </span>
          </label>
        );
      })}
    </>
  );
}

/** "person:u1" → { userId: "u1" }; "agent:a1" → { agentId: "a1" }. */
export const memberOf = (key: PickKey) =>
  key.startsWith("agent:") ? { agentId: key.slice(6) } : { userId: key.slice(7) };
