# 0160. The arrival after the onboarding, and feedback by email

- Status: Accepted
- Date: 2026-11-09
- Code: web `components/arrival/*` (`Arrival`, `BetaDialog`, `TeamScene`, `ConnectChoices`, `FeedbackDialog`,
  `FeedbackMark`), `components/ConnectAi.tsx` (`ConnectAiRequest.arrival`), `pages/OnboardingPage.tsx`
  (`?arrival=1`); server `routes/app/feedback.ts` (`POST /api/app/feedback`, `…/feedback/files`, `GET /api/feedback-files/{token}`), `auth.ts` (`auth-config.feedback`);
  engine `feedback.ts` (jobs `feedback.send`, `feedback.file.purge`), `feedback-tools.ts` (`send_feedback`); config `FEEDBACK_EMAIL`; web
  `lib/feedback.ts`, `lib/context-menu.ts` (`setMenuReporter`); table `feedback_files` (migration 0246)

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

6. **What a feedback carries.** The text the person typed; their name and address (the email's reply-to, so the
   answer goes to them); the workspace's name and their role when they are a member of the one the app named; what
   the app knows of where they are (the route's pattern and its ids, the agent open and what it thinks with, the
   connection, the language, the browser, the window, the build and the app's last errors); and what they chose to
   show: the thing they right-clicked, and files. No conversation is sent except the excerpt the form shows, which
   the person can take out. The form doesn't list the rest: it says only who reads the feedback.

7. **Through the outbox, as every email.** The route only queues job `feedback.send`; the job sends one plain email,
   outside the branded templates, since its reader is the operator. The app makes an id per message, so a request
   sent twice goes once. A person sends at most ten an hour.

8. **The way in is a row at the bottom of the sidebar**, "Send feedback" with a Beta mark at its end, shown only
   where the server takes feedback. It is not beside the person's name: a personal workspace has the person, the bell
   and the collapse on one line, with no room for a fourth thing. On the form the right hand stands with an
   envelope, takes notes while the person types and the envelope flies once it is sent. It only illustrates: no
   agent reads or sends what the form sends, and the form's words say who does.

9. **Report a problem here, on every right click.** Every menu a right click opens ends in that entry
   (`openContextMenu` with the click's target; a button's menu has none). It opens the form about the thing clicked:
   a message says who wrote it and what it says, anything else its role, its name and its words (`describeElement`),
   or only the text the person had selected there. Where it sits in the page goes along as a fact, for whoever has
   the code. A message, a card or a dialog with no menu of its own gets one with that entry alone; the page's empty
   space, links, pictures, fields and selected text keep the browser's menu.

10. **Pictures and a video, kept for a while.** A feedback takes up to three pictures of 5 MB and one video of
    50 MB. Each is uploaded as it is added (`POST /api/app/feedback/files`), into the platform's blob store, with a
    row in `feedback_files`. Sent, it gets a link only the email holds (a random token, stored hashed) that works for
    thirty days; pictures also ride inside the email. Never sent, it goes in an hour, or at once when the person
    takes it out or closes the form.

11. **What keeps it from being abused.**
    - A file is what its first bytes say (PNG, JPEG, GIF, WebP, HEIC, MP4, MOV, WebM), never what the upload calls
      itself; nothing a browser would run is among them, nor sound alone in a video's container. Only the start is
      read, so a file that begins as a picture and holds something else is kept as that picture: it is why a file
      is only ever a download of its sniffed type.
    - Sizes are refused by the declared length before a byte is read, and checked again once read.
    - A person adds thirty files an hour, four of them videos, holds six not sent yet, and sends ten feedbacks an
      hour. Only their own files, not sent yet, attach to their feedback.
    - The link answers only as a download (`content-disposition: attachment`, `nosniff`, a sandboxing policy,
      `no-store`), so this origin never shows the file; an address opens sixty a minute.
    - Everything typed or collected is inert in the email: escaped in its HTML, one line per fact, each capped.
    - The hour's limit and the declared size are answered before a byte of the upload is read, and the body is
      read only up to the largest file.
    - A purge job per deadline removes the row and the bytes; an account's deletion removes its rows at once and
      the same job its bytes. A sweep every six hours takes what a job missed: a file an hour past its time, and
      bytes with no row.

11. **An agent sends one when a person asks it to** (added 2026-11-10). `send_feedback` takes the text and queues
    the same email, to the same address, in the name of the person behind the run: their name, their address as the
    reply-to, the workspace and their role. The email says which agent wrote it ("Written by"), and "App: agent".
    It carries the text only: no files, no excerpt, nothing the app collects.
    - Every call asks that person's approval first, with the whole text on the card: it leaves the workspace in
      their name, so only they decide it, not the agent's owner nor an admin.
    - Listed only where the server takes feedback, with no scope, among the tools loaded on demand.
    - A run nobody is behind (a routine's, an agent's own) sends none: the run policy refuses a routine's, and the
      tool refuses any call with no person, or a person who is no longer a member.
    - It counts toward the same ten an hour as the person's form, and one call sends once however often it runs.

## Consequences

- A server with no `FEEDBACK_EMAIL` has no feedback channel in the apps; its people use whatever its operator gives
  them.
- Whoever has a feedback's email can open its files for thirty days without signing in: the email is the key.
- On a server with neither S3 nor a files folder, a 50 MB video sits in Postgres until it expires.
- The phone app has neither the arrival nor the form yet.
- The arrival's choice cards and the picker (ADR 0061) are two views of the same choices: a plan added to
  `PLAN_CHOICES` shows in both.
