import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

export const APP_URL = "fitviewer://app/";

export function bundlePath(url: string, root: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "fitviewer:" ||
      parsed.host !== "app" ||
      parsed.username ||
      parsed.password
    )
      return;
    const pathname = decodeURIComponent(parsed.pathname);
    if (/[\\\0]/.test(pathname)) return;
    const entry = pathname === "/" ? "/index.html" : pathname;
    if (
      entry !== "/index.html" &&
      entry !== "/THIRD_PARTY_NOTICES.txt" &&
      !entry.startsWith("/assets/")
    )
      return;
    const target = resolve(root, `.${entry}`);
    const within = relative(root, target);
    if (!within || within.startsWith("..") || isAbsolute(within)) return;
    return target;
  } catch {
    return;
  }
}

export function appNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "fitviewer:" &&
      parsed.host === "app" &&
      !parsed.username &&
      !parsed.password &&
      ["/", "/index.html"].includes(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function externalLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function contentSecurityPolicy(html: string): string {
  const hashes = Array.from(
    html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
  )
    .filter((match) => !/\bsrc\s*=/.test(match[0].split(">")[0]))
    .map(
      (match) =>
        `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`,
    );
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
