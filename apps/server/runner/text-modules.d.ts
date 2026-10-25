/** Files the runner embeds as text (`with { type: "text" }`: Bun inlines them in the bundle). */
declare module "*.py" {
  const source: string;
  export default source;
}
