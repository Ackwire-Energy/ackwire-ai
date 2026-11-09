/**
 * Masks what looks like a credential in free text that leaves its place (the runner's diagnostics and
 * activity log, the operator API's review block): machine tokens, bearer headers, common API key shapes,
 * `password=`/`token=` values. The agent's own secrets are masked by their values (ADR 0027) before this.
 */
export function redactCommon(text: string): string {
  return text
    .replace(/\bagm_[A-Za-z0-9_-]{6,}/g, "agm_***")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{12,})/g, "sk-***")
    .replace(/\b(gh[pousr]_[A-Za-z0-9._-]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "gh_***")
    .replace(/\b(xox[abposr]-[A-Za-z0-9-]{10,})/g, "xox-***")
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, "AKIA***")
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1***");
}
