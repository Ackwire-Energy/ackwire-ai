import type { OutboxStorage } from "@agenteschat/client";
import { File, Paths } from "expo-file-system";

/** In the app's own documents (not the cache, which the system may clear): what still has to go out. */
const file = () => new File(Paths.document, "outbox.json");

/** My messages waiting for the connection (the shared `outbox`), kept when the system closes the app: never throws. */
export const outboxStore: OutboxStorage = {
  read: () => {
    try {
      const f = file();
      return f.exists ? f.textSync() : null;
    } catch {
      return null;
    }
  },
  write: (value) => {
    try {
      file().writeSync(value);
    } catch {
      // Not kept: it still goes out while the app stays open.
    }
  },
};
