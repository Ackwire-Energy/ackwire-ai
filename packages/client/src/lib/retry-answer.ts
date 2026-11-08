import type { ApiClient } from "../api/client";
import { ApiError } from "../api/http";
import type { Message } from "../api/types";
import { errorCode } from "./errors";
import { voiceOf } from "./voice";

/** Messages with a retry on its way: a second tap while it is does nothing. */
const inFlight = new Set<string>();

/**
 * "Tentar de novo" under my message an agent couldn't answer: the agent answers the same message again, so it never
 * shows twice. Only when that can't be (it went into a task already at work, the failed run was long work, or it had
 * done things that starting over would repeat) do its words go again (`resend`). A voice message's words never go
 * again as text: it is recorded again, and the error says so (`run.not_restartable_voice`).
 */
export async function retryAnswer(api: ApiClient, orgId: string, message: Message, resend: () => void) {
  if (inFlight.has(message.id)) return;
  inFlight.add(message.id);
  const again = () => {
    if (voiceOf(message.meta)) throw new ApiError(409, "run.not_restartable_voice", "Record the message again");
    resend();
  };
  try {
    const { runs } = await api.chat.answerNow(orgId, message.id);
    if (runs.length === 0) again();
  } catch (error) {
    if (errorCode(error) !== "run.not_restartable") throw error;
    again();
  } finally {
    inFlight.delete(message.id);
  }
}
