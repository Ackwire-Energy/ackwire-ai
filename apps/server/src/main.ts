/**
 * The image's entrypoint. `main.ts migrate` (`docker compose run --rm agentes migrate`)
 * only prepares the database the way boot does, then exits: an upgrade can
 * migrate while the previous version still serves.
 */
import { loadConfig } from "@agenteschat/config";
import { createDatabase } from "@agenteschat/db";
import { createLogger } from "./logger";
import { prepareDatabase, startServer } from "./start";

if (process.argv[2] === "migrate") {
  const config = loadConfig();
  const database = createDatabase({ url: config.DATABASE_URL, poolMax: config.DATABASE_POOL_MAX });
  await prepareDatabase(database, createLogger(config.LOG_LEVEL));
  await database.close();
  process.exit(0);
}

await startServer({ edition: "selfhost" });
