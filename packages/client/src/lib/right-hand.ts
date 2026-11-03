import type { Agent } from "../api/types";

/** The workspace's right hand (ADR 0134): every surface that treats it apart asks here. */
export const isRightHand = (agent: Pick<Agent, "builtin"> | null | undefined) => agent?.builtin === "right_hand";
