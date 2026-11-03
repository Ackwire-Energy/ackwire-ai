import type { ApiClient } from "../api/client";
import type { Message } from "../api/types";
import { errorCode } from "./errors";

/** Messages with a retry on its way: a second tap while it is does nothing. */
const inFlight = new Set<string>();

/**
 * "Tentar de novo" under my message an agent couldn't answer: the agent answers the same message again, so it never
 * shows twice. Only when that can't be (it went into a task already at work, the failed run was long work, or it had
 * done things that starting over would repeat) do its words go again (`resend`).
 */
export async function retryAnswer(api: ApiClient, orgId: string, message: Message, resend: () => void) {
  if (inFlight.has(message.id)) return;
  inFlight.add(message.id);
  try {
    const { runs } = await api.chat.answerNow(orgId, message.id);
    if (runs.length === 0) resend();
  } catch (error) {
    if (errorCode(error) !== "run.not_restartable") throw error;
    resend();
  } finally {
    inFlight.delete(message.id);
  }
}
