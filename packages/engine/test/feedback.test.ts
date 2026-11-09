import { expect, test } from "bun:test";
import { createFakeEmailSender } from "@agenteschat/adapters";
import { FEEDBACK_MAX, PermanentJobError, renderFeedback, sendQueuedFeedback } from "../src";

const feedback = {
  to: "feedback@example.com",
  name: "Ana Lima",
  email: "ana@example.com",
  text: "  The sky is too dark\nat night.  ",
  version: "1.2.3",
};

test("a feedback email: the person's words first, then who wrote them and from where", () => {
  const mail = renderFeedback({ ...feedback, orgName: "Acme", where: "/org/x", app: "web" });
  expect(mail.subject).toBe("Feedback from Ana Lima");
  expect(mail.text).toBe(
    "The sky is too dark\nat night.\n\n--\nFrom: Ana Lima <ana@example.com>\nWorkspace: Acme\nScreen: /org/x\nApp: web\nServer: 1.2.3\n",
  );
  expect(mail.html).toContain("The sky is too dark\nat night.");
});

test("a feedback email: a name can't start another line or header, the text is cut and inert", () => {
  const mail = renderFeedback({
    ...feedback,
    name: "Ana\r\nBcc: everyone@example.com",
    text: `<script>alert(1)</script>${"x".repeat(FEEDBACK_MAX)}`,
  });
  expect(mail.subject).toBe("Feedback from Ana Bcc: everyone@example.com");
  expect(mail.html).toContain("&lt;script&gt;");
  expect(mail.html).not.toContain("<script>");
  expect(mail.text.split("\n\n--\n")[0]).toHaveLength(FEEDBACK_MAX);
  // No name: the address stands for it.
  expect(renderFeedback({ ...feedback, name: " " }).subject).toBe("Feedback from ana@example.com");
});

test("the feedback job: answered to the person, sent once per key, and nothing without text", async () => {
  const sender = createFakeEmailSender();
  await sendQueuedFeedback(sender, { key: "u1:m1", feedback });
  expect(sender.sent).toHaveLength(1);
  expect(sender.sent[0]).toMatchObject({
    to: ["feedback@example.com"],
    replyTo: "ana@example.com",
    idempotencyKey: "feedback:u1:m1",
  });
  await expect(
    sendQueuedFeedback(sender, { key: "u1:m2", feedback: { ...feedback, text: "" } }),
  ).rejects.toBeInstanceOf(PermanentJobError);
});
