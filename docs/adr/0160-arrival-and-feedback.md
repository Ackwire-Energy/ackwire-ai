# 0160. The arrival after the onboarding, and feedback by email

- Status: Accepted
- Date: 2026-11-09
- Code: web `components/arrival/*` (`Arrival`, `BetaDialog`, `TeamScene`, `ConnectChoices`, `FeedbackDialog`,
  `FeedbackMark`), `components/ConnectAi.tsx` (`ConnectAiRequest.arrival`), `pages/OnboardingPage.tsx`
  (`?arrival=1`); server `routes/app/feedback.ts` (`POST /api/app/feedback`), `auth.ts` (`auth-config.feedback`);
  engine `feedback.ts` (job `feedback.send`); config `FEEDBACK_EMAIL`

## Context

A new workspace's owner landed in the right hand's conversation with a checklist, and nothing said two things they
need to know at once: the product is in beta, and their agents answer nothing until an AI is connected. Connect an AI
was a row among five, opening a picker of two controls made for people who already know what a plan and a key are.

There was also no way to tell us what went wrong. The product is open source and one image serves every server
(ADR 0002), so a feedback channel must not send anything to agentes.chat from a server someone else runs, must work
with Postgres alone, and must not need a third-party widget in the apps.

## Decision

1. **The arrival is asked for by the address.** The onboarding's last step opens the workspace with `?arrival=1`.
   `Arrival` reads it once and drops it, so a reload or Back shows nothing again. Nothing is stored: a person who
   joins by invitation, or who closes the tab before it opens, doesn't get it. That is acceptable for a notice.

2. **First the beta notice, then Connect an AI.** The notice says the product is in beta and what that means, and,
   only where the server takes feedback, where to send it. Every way out of it goes on. Connect an AI follows for a
   person who has one to connect (`useMayConnectAi`) while some agent has none.

3. **Connect an AI gets a stage, not a second flow.** Opened with `arrival`, the same dialog (ADR 0061) shows the
   workspace's agents asleep under a night sky beside the choices, and the sky turns to day as they wake once an AI
   is connected. Its first screen is one card per choice, in words: Claude, ChatGPT, the other plans, an API key
   (for whoever may add one), and OpenCode's free models as the way in without a subscription. A pick opens that
   plan's own steps (`PlanPanel`, `KeyPanel`) unchanged, with Back to the cards. A billing hold keeps its own notice,
   without the stage.

4. **One sky for the three.** `TeamScene` draws night and day on the shared sky engine and the agents with the
   living avatar (`sleeping`, `writing`, an expression). It is decorative everywhere: what it says is also said in
   words.

5. **Feedback is an email to whoever runs the server.** `FEEDBACK_EMAIL` names the address. Unset, which is the
   default, the apps show no form and the route answers 404: a self-hosted server sends nothing anywhere unless its
   operator asks for it. agentes.chat sets it to its own address.

6. **What a feedback carries.** The text the person typed, their name and address (the email's reply-to, so the
   answer goes to them), the workspace's name when they are a member of the one the app named, the screen's path,
   the app and the server's version. Never a conversation, a file or a screenshot. The form says so before sending.

7. **Through the outbox, as every email.** The route only queues job `feedback.send`; the job sends one plain email,
   outside the branded templates, since its reader is the operator. The app makes an id per message, so a request
   sent twice goes once. A person sends at most ten an hour.

8. **The way in is a row at the bottom of the sidebar**, "Send feedback" with a Beta mark at its end, shown only
   where the server takes feedback. It is not beside the person's name: a personal workspace has the person, the bell
   and the collapse on one line, with no room for a fourth thing. On the form the right hand stands with an
   envelope, takes notes while the person types and the envelope flies once it is sent. It only illustrates: no
   agent reads or sends the feedback, and the form's words say who does.

## Consequences

- A server with no `FEEDBACK_EMAIL` has no feedback channel in the apps; its people use whatever its operator gives
  them.
- A screenshot can't be attached yet. The email sender takes pictures only inline in a template, and a picture in an
  outbox job's payload would sit in the database.
- The phone app has neither the arrival nor the form yet.
- The arrival's choice cards and the picker (ADR 0061) are two views of the same choices: a plan added to
  `PLAN_CHOICES` shows in both.
