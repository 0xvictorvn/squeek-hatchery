// Validators come from the bytes just read. Do not cache bodies or size/mtime tags.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

export type StaticRootKind = "dist" | "public" | "lab" | "project";

export interface StaticServeOptions {
  rootKind?: StaticRootKind;
  publicPath?: string;
  spaDocument?: boolean;
}

export interface StaticCacheClass {
  cacheControl: string;
  conditional: boolean;
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";
const HASHED_BUILD_ASSET =
  /^\/assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9]+)+$/;

function normalizePublicPath(input: string): string {
  const withoutQuery = input.split("?")[0] ?? "/";
  const withoutHash = withoutQuery.split("#")[0] ?? "/";
  return withoutHash.startsWith("/") ? withoutHash : `/${withoutHash}`;
}

function isStableRevalidated(rootKind: StaticRootKind, publicPath: string): boolean {
  if (rootKind !== "public" && rootKind !== "dist" && rootKind !== "lab") return false;
  const ext = path.posix.extname(publicPath).toLowerCase();
  const image =
    ext === ".png" ||
    ext === ".jpg" ||
    ext === ".jpeg" ||
    ext === ".webp" ||
    ext === ".gif" ||
    ext === ".svg" ||
    ext === ".ico";
  if (publicPath === "/favicon.ico" || publicPath === "/favicon.svg") return true;
  if (
    image &&
    (publicPath.startsWith("/art/") ||
      publicPath.startsWith("/backgrounds/") ||
      publicPath.startsWith("/lab-assets/"))
  ) {
    return true;
  }
  if ((rootKind === "public" || rootKind === "dist") && ext === ".json" && !publicPath.startsWith("/assets/")) {
    return true;
  }
  return rootKind === "lab";
}

export function classifyStaticCache(input: {
  rootKind: StaticRootKind;
  publicPath: string;
  method: string;
  spaDocument?: boolean;
}): StaticCacheClass {
  const method = input.method.toUpperCase();
  const publicPath = normalizePublicPath(input.publicPath);
  if (method !== "GET" && method !== "HEAD") {
    return { cacheControl: "no-store", conditional: false };
  }
  if (input.rootKind === "dist" && HASHED_BUILD_ASSET.test(publicPath)) {
    return { cacheControl: IMMUTABLE, conditional: true };
  }
  if (input.spaDocument || publicPath === "/index.html" || publicPath.endsWith(".html")) {
    if (input.rootKind === "project" && !input.spaDocument && publicPath !== "/index.html") {
      return { cacheControl: "no-store", conditional: false };
    }
    return { cacheControl: "no-cache", conditional: true };
  }
  if (isStableRevalidated(input.rootKind, publicPath)) {
    return { cacheControl: REVALIDATE, conditional: true };
  }
  return { cacheControl: "no-store", conditional: false };
}

function headerText(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

function parseEtagList(header: string): string[] {
  const tags: string[] = [];
  let i = 0;
  while (i < header.length) {
    while (i < header.length && (header[i] === " " || header[i] === "\t" || header[i] === ",")) i += 1;
    if (i >= header.length) break;
    if (header[i] === "*") {
      tags.push("*");
      i += 1;
      continue;
    }
    let weak = false;
    if ((header[i] === "W" || header[i] === "w") && header[i + 1] === "/") {
      weak = true;
      i += 2;
      while (i < header.length && (header[i] === " " || header[i] === "\t")) i += 1;
    }
    if (header[i] !== '"') {
      const start = i;
      while (i < header.length && header[i] !== ",") i += 1;
      const token = header.slice(start, i).trim();
      if (token) tags.push(weak ? `W/${token}` : token);
      continue;
    }
    i += 1;
    let value = "";
    while (i < header.length) {
      const ch = header[i];
      if (ch === "\\") {
        value += header[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') break;
      value += ch;
      i += 1;
    }
    if (header[i] === '"') i += 1;
    const quoted = `"${value}"`;
    tags.push(weak ? `W/${quoted}` : quoted);
  }
  return tags;
}

function etagToken(tag: string): string {
  return tag.trim().replace(/^W\//i, "").trim();
}

function ifNoneMatchDecision(
  header: string | string[] | undefined,
  etag: string,
): "absent" | "match" | "miss" {
  if (header === undefined) return "absent";
  const tags = parseEtagList(headerText(header) ?? "");
  if (tags.length === 0) return "miss";
  for (const tag of tags) {
    if (tag === "*") return "match";
    if (etagToken(tag) === etagToken(etag)) return "match";
  }
  return "miss";
}

function modifiedSinceMatches(header: string | string[] | undefined, mtimeMs: number): boolean {
  const raw = headerText(header);
  if (!raw) return false;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return false;
  return Math.floor(mtimeMs / 1000) <= Math.floor(parsed / 1000);
}

export function writePlainStaticError(
  res: ServerResponse,
  status: number,
  message: string,
  contentType = "text/plain; charset=utf-8",
  method = "GET",
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (method.toUpperCase() === "HEAD") {
    res.setHeader("Content-Length", Buffer.byteLength(message));
    res.end();
    return;
  }
  res.end(message);
}

export function writeStaticBytes(
  req: IncomingMessage | undefined,
  res: ServerResponse,
  bytes: Buffer,
  mtimeMs: number,
  contentType: string,
  policy: StaticCacheClass,
): void {
  const method = (req?.method ?? "GET").toUpperCase();
  res.setHeader("Content-Type", contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", policy.cacheControl);

  if (policy.conditional && (method === "GET" || method === "HEAD")) {
    const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
    const lastModified = new Date(mtimeMs).toUTCString();
    res.setHeader("ETag", etag);
    res.setHeader("Last-Modified", lastModified);
    const decision = ifNoneMatchDecision(req?.headers["if-none-match"], etag);
    const notModified =
      decision === "match" ||
      (decision === "absent" && modifiedSinceMatches(req?.headers["if-modified-since"], mtimeMs));
    if (notModified) {
      res.statusCode = 304;
      res.removeHeader("Content-Length");
      res.removeHeader("Transfer-Encoding");
      res.end();
      return;
    }
  }

  res.statusCode = 200;
  res.setHeader("Content-Length", String(bytes.length));
  if (method === "HEAD") res.end();
  else res.end(bytes);
}
