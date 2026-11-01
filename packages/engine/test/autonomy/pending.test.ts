import { pending } from "./known";

// Scenarios of the design that have no body yet: each needs a harness piece this suite doesn't have (a paired fake
// computer, a mission, a coding CLI brain), and names the branch it waits on. Give one a body in the file of its
// invariant when its piece lands.

const COMPUTER = "needs a paired fake computer (machine-fixtures) in the world";

pending("S14", "a task's end wakes a turn that can act; no nudge while the task runs", ["work-by-default"], COMPUTER);
pending("S15", "a background Claude task runs on the agent's own sign-in", ["tasks-use-agent-sign-in"], "runner side");
pending("S16", "a failing task wakes the agent, which fixes and retries", ["work-by-default"], COMPUTER);
pending(
  "S19",
  "a mission with open items keeps going with no person writing",
  ["controller", "missions-keep-going"],
  COMPUTER,
);
pending(
  "S20",
  "a mission run and a top-level DM to the same agent run side by side",
  ["missions-keep-going"],
  COMPUTER,
);
pending(
  "S23",
  "a computer that drops mid-review: the run waits and resumes the same turn",
  ["handoffs-come-back"],
  COMPUTER,
);
pending(
  "S24",
  "a Codex resume into a folder gone after the drop starts fresh with a note",
  [],
  "closed on main (sessionLost, ADR 0032 addendum; engine-brains.test.ts); end to end needs a paired fake computer",
);
pending(
  "S28",
  "a plan usage limit parks the run and resumes it after the reset",
  ["usage-limit-safe"],
  "needs the claude_code brain",
);
pending("S35", "after folder access is allowed, the resumed run can continue the edit", ["work-by-default"], COMPUTER);
pending(
  "S36",
  "after a proposed agent is created, the run can ask it and add it",
  ["work-by-default"],
  "proposal flow",
);
pending("S42", "a person writing into an unattended run puts that person behind it", [], "live steering in the world");
