# 0158. Onboarding: the blue rail with Lodi

- Status: Accepted
- Date: 2026-11-08
- Amends: 0137 §6 (the onboarding asked only the workspace's name, then its right hand's DM), 0155 §6 (the right
  hand's card had five rows), 0079 §3 (the billing link's claims) and §7 (where a hold offers the plan), 0071 §3 (when
  our notifications ask opens)
- Code: client `lib/onboarding.ts` (`railSteps`, `railStepAt`, `railState`, `landingOf`),
  `lib/setup-checklist.ts` (three rows, invitations finish the people row), `lib/push-offer.ts` (`pushAskAt`),
  `lib/billing.ts` (`planOfferOf`); engine `team-templates.ts` (`sayTeamHello`), `standing.ts` (`TEAM_HELLO_JOB`
  queued by `setBillingHold`), `billing-link.ts` (`plan`); web `pages/OnboardingPage.tsx`, `pages/onboarding/*`,
  `components/Sky.tsx` (`OnboardingProgress`, `TeamAsleepSky`), `lib/plan-offer.ts`, `components/FirstRun.tsx`,
  `components/WebPush.tsx` (`PushAskInline`), `routes/onboarding.tsx`; phone `features/onboarding/OnboardingFlow.tsx`,
  `features/onboarding/steps.tsx`

## Context

The onboarding asked one question, the workspace's name, and opened its right hand's DM, whose card held the rest:
what the workspace does, the team, an AI, apps, people, with the plan offered from three places at once. People met the
notifications dialog over that card on arrival, the plan's price was nowhere, and paying landed back at the bottom of a
DM with Lodi alone saying thanks.

## Decision

### 1. Four steps on the rail, before the workspace opens

The rail of the older onboarding comes back with Lodi on its horizon, one line per step, and the progress strip with its
walking pixel agent: the workspace's name (which creates it), what it does (the business types and one optional
sentence, saved together as its context, "Loja online · Vendemos cerâmica", so any later visit reads both back), its
team (a template made in one click, no model call), and, only on a workspace that waits for its first plan, the plan.
On wide screens the workspace's sidebar fills in beside the question. The step is read from the workspace's data (it
exists, has a context, has a team, waits for a plan), asked again whenever the tab or the app comes back, so a workspace
left at any step, or answered in another tab or on the phone, resumes there and is never finished behind the person's
back.

### 2. The plan step

The team asleep on the agents' sky, what each one does (its first routine), the plan the billing service recommends
with its price, "Ligar o time", "Ver todos os planos" and "Entrar no workspace sem ligar". The browser reads the plan
from the billing service's public list (`GET {billingUrl}/plans.json?locale=`): this server still names no plan or
price. Without that list the step names no plan and its button opens the billing page. The billing link may carry the
plan picked (`plan`, the billing service's own key), which this server passes on unread. Self-hosted servers have no
plan step. The phone app shows the team asleep and where to turn it on, with no price and no link.

### 3. Where it opens

Paid: #general (`?paid`), where the hold banner says the payment is being confirmed. Done with no plan to wait for:
#general. The plan left for later: the right hand's DM, where the hold's banner is the one way to the plan.

### 4. The team says hi

When the first plan starts (the `payment` hold lifts), or when a template team is made where no plan is waited for, the
team says hi in #general, one line each 1.1 s apart, the right hand first: no model call, no run, no notification,
`meta.greeting`. Template agents join #general answering only when called. The right hand's line names its computer
only while the workspace's computer is on its way.

### 5. The right hand's card keeps what the onboarding didn't do

An AI (for the whole team), apps, people. An invitation waiting for its answer finishes the people row, which invites one
address in place. On a hold every row waits for the plan with no button of its own. "Agora não" says nothing.

### 6. Our notifications ask waits

Never on arrival and never a dialog: a card under the first answer from an agent the person wrote to, and once more
under the first request waiting on them. Never on a billing hold.

### 7. The phone

The same steps from the same data (`railState`), on the screen the sign-in already uses: the right hand stands on the
sky and says its line for each step under the question, the template's team joins it there on step 3 and sleeps there
on step 4. Step 2 is the business list and the sentence, step 3 the template's team with its picker, step 4 what each
agent does first and, in words only, where the plan is chosen ("Entrar no workspace" opens the right hand's DM). The
way out of the account stays one quiet "Sair".

## Consequences

- The rail CSS stays shared with Criar agente (`layout.css`); its answers wrap instead of ending in an ellipsis.
- The held template example, the card's about and team rows and the notifications dialog are gone, with their words in
  every language.
- The billing service publishes `plans.json` and reads the link's `plan`: a change of its own, after this one.

## Amended 2026-11-09: what the first end-to-end take showed

- **The plan brings no AI, and the words say so.** Step 4 reads "Com o plano e uma IA, ele começa hoje", Lodi says
  that after the plan an AI is left, and while nothing in the workspace thinks his hello asks for one
  (`teamTemplates.hello.lodiNoAi`, `orgHasAi`) right above the bar that connects it, instead of starting the work.
- **One team order everywhere, the template's.** Agents made in one transaction keep the order they were made in
  (`createdAt` is the insert's `clock_timestamp()`), the agents' list follows it (by name only where older teams share a
  time), and the onboarding, the rail, the preview, step 4 and the sidebar's day-one pins (`dayOnePins`) list it as
  given. The members column keeps its own alphabetical order, as for people.
- **The preview** names the workspace "Seu workspace" until one is typed, and counts every agent it lists, the right
  hand included, as the workspace's sidebar now does (`orgOverview`).
- **The right hand's card:** an invitation only sent says "Convite enviado." with no burst (`firstRunBeats`); someone
  joining gets the welcome. The first task is offered once, on the team card ("Primeira tarefa"), never again among the
  card's asks. "Como prefere que eu fale com você?" waits until a team agent worked once (`teamAnswered`), so it never
  stands beside the first task.
- **A new agent's greeting** asks for help only when something is left as its checklist first loads.
- **The floating date** never floats over the conversation's start (the greeting and its cards): above the first day it
  shows nothing (`dayAtTop`, the phone's `dayInView`).
- **The computer notice** says no line under its title before the provisioner names a step (`setupNoticeStatusKey`).
