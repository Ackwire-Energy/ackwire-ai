/**
 * What the iPhone app leaves out for the App Store (its guideline 3.1.3(f)): a free app beside a service paid for
 * on the web has no purchase inside, and no call to one outside. So on iOS nobody reads where the plan is paid, a
 * tap never opens the plan's page, and on agentes.chat's own servers, where a new account starts with a plan to
 * choose, accounts are not made in the app. Pure: the platform comes in as `os`.
 */

/** Whether the words say where the plan is paid, to someone who may pay it: never on iOS, where they read as anyone. */
export const saysWhereToPay = (mayPay: boolean, os: string) => mayPay && os !== "ios";

/**
 * Whether an e-mail with no account may make one here. Not on iOS on one of agentes.chat's own servers; an
 * invitation still does (its workspace has its plan), and so does any other server, which has none.
 */
export const signUpInApp = (os: string, cloud: boolean | undefined) => !(os === "ios" && cloud === true);

/** The plan's page on the website (`/org/<id>/settings/billing`), the one page a tap never opens on iOS. */
export const webPathOpens = (path: string, os: string) =>
  !(os === "ios" && /\/settings\/billing(?:[/?#]|$)/.test(path));
