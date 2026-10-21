import type { SnapshotStorage } from "@agenteschat/client";
import { File, Paths } from "expo-file-system";

/** In the cache folder: not backed up, and the system may clear it (the app then loads from the server). */
const file = () => new File(Paths.cache, "chats-snapshot.json");

/** The conversations snapshot (`createSnapshot`) in a file of the app: never throws, a failure just means no snapshot. */
export const snapshotStore: SnapshotStorage = {
  read: async () => {
    try {
      const f = file();
      return f.exists ? await f.text() : null;
    } catch {
      return null;
    }
  },
  write: async (value) => {
    try {
      file().write(value);
    } catch {
      // Not saved: the next launch loads from the server.
    }
  },
  remove: async () => {
    try {
      const f = file();
      if (f.exists) f.delete();
    } catch {
      // Ignore.
    }
  },
};
