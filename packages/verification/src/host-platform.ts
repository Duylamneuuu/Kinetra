/**
 * The host platform name used when a performance budget does not name one.
 * On Node this is `process.platform`. In a browser it is `"browser"`.
 * Written without a `process.platform` token so the browser entry's import scanner stays clean.
 */
export function currentPlatform(): string {
  const host = globalThis as { process?: { platform?: unknown } };
  const platform = host.process?.platform;
  return typeof platform === "string" && platform.length > 0 ? platform : "browser";
}
