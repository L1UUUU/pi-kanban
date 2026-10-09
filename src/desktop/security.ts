export const WORKBENCH_URL = 'app://workbench/index.html';
export function isTrustedSender(url: string, isMainFrame: boolean): boolean {
  return isMainFrame && url === WORKBENCH_URL;
}
export function assetName(url: string): 'index.html' | 'app.js' | 'app.css' | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== 'app:' || parsed.hostname !== 'workbench' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
  const candidate = parsed.pathname.slice(1);
  return candidate === 'index.html' || candidate === 'app.js' || candidate === 'app.css' ? candidate : undefined;
}
