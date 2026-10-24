/** Shell scripts imported as text (`with { type: "text" }`), like the installer `app.ts` serves. */
declare module "*.sh" {
  const text: string;
  export default text;
}
