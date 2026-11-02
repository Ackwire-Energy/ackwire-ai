/** The runner's local, inert new-tab page (protocol 33). */
export const START_PAGE_ID = "mbgkclemiokgppkieijlfaoehgdjlhbl";
export const START_PAGE_URL = "chrome://newtab/";
export const isStartPage = (url: string) =>
  url === START_PAGE_URL || url === `chrome-extension://${START_PAGE_ID}/start.html`;
