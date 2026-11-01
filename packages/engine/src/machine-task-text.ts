/** `3 min`, `1 h 05 min`, `40 s`. */
export function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** A task's end as its line needs it: the same fields as the end notice's `meta.machineTask`. */
export interface TaskEnd {
  title: string;
  status: string;
  seconds: number;
  exitCode: number | null;
  /** Commands a mission's rules blocked along the way. */
  blocked?: { command: string }[];
}

/**
 * A task's end in its thread, in English (the apps show its `bodyCode` in the person's words). `computer`: where it
 * ran, or null for a line that doesn't say (a notification where the workspace has only one computer).
 */
export function taskEndText(task: TaskEnd, computer: string | null) {
  const took = formatDuration(task.seconds);
  const on = computer ? ` on ${computer}` : "";
  const blocked = task.blocked?.length ? ` Blocked: ${task.blocked.map((d) => `\`${d.command}\``).join(", ")}.` : "";
  switch (task.status) {
    case "done":
      return `Task "${task.title}" finished${on} after ${took}.${blocked}`;
    case "canceled":
      return `Task "${task.title}" was canceled${on} after ${took}.${blocked}`;
    case "interrupted":
      return `Task "${task.title}" was interrupted${on} after ${took} (the computer went away) and couldn't resume by itself.${blocked}`;
    default:
      return `Task "${task.title}" failed${on} after ${took} (exit code ${task.exitCode ?? "none"}).${blocked}`;
  }
}
