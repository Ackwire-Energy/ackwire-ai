/**
 * The landing page's strings (`landing.*`), one file per section so each can
 * change on its own. Every file exports `pt` (the source) and `en`.
 */

import * as bento from "./bento";
import * as computer from "./computer";
import * as control from "./control";
import * as demo from "./demo";
import * as devices from "./devices";
import * as faq from "./faq";
import * as hero from "./hero";
import * as missions from "./missions";
import * as onboarding from "./onboarding";
import * as shared from "./shared";
import * as story from "./story";
import * as team from "./team";

export const landingPtBR = {
  ...shared.pt,
  ...hero.pt,
  ...story.pt,
  ...demo.pt,
  ...team.pt,
  ...bento.pt,
  ...control.pt,
  ...faq.pt,
  ...computer.pt,
  ...missions.pt,
  ...devices.pt,
  ...onboarding.pt,
};

export const landingEn = {
  ...shared.en,
  ...hero.en,
  ...story.en,
  ...demo.en,
  ...team.en,
  ...bento.en,
  ...control.en,
  ...faq.en,
  ...computer.en,
  ...missions.en,
  ...devices.en,
  ...onboarding.en,
};
