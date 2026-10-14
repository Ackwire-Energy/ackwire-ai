/**
 * Self-hosted entrypoint. This is what the public image runs.
 * agentes.chat Cloud starts the same server from the private
 * `agentes-chat-cloud` repository with extra modules.
 */
import { startServer } from "./start";

await startServer({ edition: "selfhost" });
