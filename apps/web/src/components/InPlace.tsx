import { useIssue } from "@agenteschat/client";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { IssueDialog } from "@/pages/IssuePage";
import { RoutineOver } from "@/pages/RoutinesPage";

/** Opens what a conversation names in its own dialog, over the conversation. */
export interface InPlace {
  routine: (id: string) => void;
  issue: (number: number) => void;
}

const InPlaceContext = createContext<InPlace | null>(null);

type Shown = { kind: "routine"; id: string } | { kind: "issue"; number: number };

/**
 * In a conversation, a routine or a task an agent names (its receipt, the tag on a routine's message, an issue's
 * card) opens in its dialog over the conversation, not on its page: closing it leaves the person where they were.
 */
export function InPlaceProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const close = useCallback(() => setShown(null), []);
  const value = useMemo<InPlace>(
    () => ({
      routine: (id) => setShown({ kind: "routine", id }),
      issue: (number) => setShown({ kind: "issue", number }),
    }),
    [],
  );
  return (
    <InPlaceContext.Provider value={value}>
      {children}
      {shown?.kind === "routine" && <RoutineOver key={shown.id} id={shown.id} onClose={close} />}
      {shown?.kind === "issue" && <IssueOver key={shown.number} number={shown.number} onClose={close} />}
    </InPlaceContext.Provider>
  );
}

/** Opens a routine or a task over the conversation; null elsewhere (callers link to its page instead). */
export const useInPlace = () => useContext(InPlaceContext);

/** A task's dialog by its number, once loaded; gone or out of reach, a toast says so. */
function IssueOver({ number, onClose }: { number: number; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const issue = useIssue(org.id, number);
  useEffect(() => {
    if (!issue.isError) return;
    toast.show(t("issues.notFound"), "error");
    onClose();
  }, [issue.isError, toast, t, onClose]);
  return issue.data ? <IssueDialog issue={issue.data} onClose={onClose} /> : null;
}
