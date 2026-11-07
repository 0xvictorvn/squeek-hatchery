import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HatcheryBackend, type BackendOptions } from "./backend.ts";
import {
  classifyStaticCache,
  writePlainStaticError,
  writeStaticBytes,
  type StaticRootKind,
  type StaticServeOptions,
} from "./static-cache.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const LAB_ASSETS_ROOT = path.resolve(PROJECT_ROOT, "../hamster-trait-lab/assets");
const DIST_ROOT = path.resolve(PROJECT_ROOT, "dist");
const PUBLIC_ROOT = path.resolve(PROJECT_ROOT, "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export interface HatcheryStaticRoots {
  dist: string;
  publicDir: string;
  lab: string;
  project: string;
}

export function tryServeStaticFile(
  rootDir: string,
  relativePath: string,
  res: ServerResponse,
  req?: IncomingMessage,
  options?: StaticServeOptions,
): boolean {
  const safeRel = relativePath.replace(/^[/\\]+/, "");
  const resolved = path.resolve(rootDir, safeRel);
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (resolved !== rootDir && !resolved.startsWith(rootWithSep)) {
    writePlainStaticError(res, 403, "Forbidden", undefined, req?.method);
    return true;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const bytes = fs.readFileSync(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const publicPath = options?.publicPath ?? `/${safeRel.split(path.sep).join("/")}`;
  const policy = classifyStaticCache({
    rootKind: options?.rootKind ?? "project",
    publicPath,
    method: req?.method ?? "GET",
    spaDocument: options?.spaDocument,
  });
  const mtimeMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : stat.mtime.getTime();
  writeStaticBytes(req, res, bytes, mtimeMs, MIME_TYPES[ext] ?? "application/octet-stream", policy);
  return true;
}

function serveRoot(
  req: IncomingMessage,
  res: ServerResponse,
  rootDir: string,
  relativePath: string,
  rootKind: StaticRootKind,
  publicPath: string,
  spaDocument = false,
): boolean {
  return tryServeStaticFile(rootDir, relativePath, res, req, {
    rootKind,
    publicPath,
    spaDocument,
  });
}

const STATIC_ASSET_EXT_RE =
  /\.(?:js|mjs|css|json|png|jpg|jpeg|webp|gif|svg|ico|map|txt|woff|woff2|ttf)$/i;

export function normalizeNestedStaticPath(pathname: string): {
  isLabAsset: boolean;
  labAssetRelPath: string;
  staticCandidatePath: string;
  isAssetRequest: boolean;
} {
  const labMatch = pathname.match(
    /^(?:\/(?:(?:result|nft)(?:\/[^/]+)?|docs|leaderboard))?\/lab-assets\/(.+)$/,
  );
  if (labMatch) {
    return {
      isLabAsset: true,
      labAssetRelPath: labMatch[1]!,
      staticCandidatePath: `/lab-assets/${labMatch[1]!}`,
      isAssetRequest: true,
    };
  }

  const assetsMatch = pathname.match(
    /^(?:\/(?:(?:result|nft)(?:\/[^/]+)?|docs|leaderboard))?\/assets\/(.+)$/,
  );
  if (assetsMatch) {
    return {
      isLabAsset: false,
      labAssetRelPath: "",
      staticCandidatePath: `/assets/${assetsMatch[1]!}`,
      isAssetRequest: true,
    };
  }

  const nestedRootFileMatch = pathname.match(
    /^(?:\/(?:(?:result|nft)(?:\/[^/]+)?|docs|leaderboard))\/([^/]+\.[a-z0-9]+)$/i,
  );
  if (nestedRootFileMatch && STATIC_ASSET_EXT_RE.test(nestedRootFileMatch[1]!)) {
    return {
      isLabAsset: false,
      labAssetRelPath: "",
      staticCandidatePath: `/${nestedRootFileMatch[1]!}`,
      isAssetRequest: true,
    };
  }

  return {
    isLabAsset: false,
    labAssetRelPath: "",
    staticCandidatePath: pathname,
    isAssetRequest: STATIC_ASSET_EXT_RE.test(pathname),
  };
}

export function createHatcheryHttpServer(
  options: BackendOptions = {},
  staticRoots?: HatcheryStaticRoots,
): {
  backend: HatcheryBackend;
  server: http.Server;
} {
  const roots = staticRoots ?? {
    dist: DIST_ROOT,
    publicDir: PUBLIC_ROOT,
    lab: LAB_ASSETS_ROOT,
    project: PROJECT_ROOT,
  };
  const defaultDbPath = path.resolve(PROJECT_ROOT, "cache", "hatchery-backend.sqlite");
  const backend = new HatcheryBackend({
    autoStartProducer: true,
    ...options,
    dbPath: options.dbPath ?? defaultDbPath,
  });

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const handledApi = await backend.handleApiRequest(req, res);
      if (handledApi) return;

      const urlObj = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = decodeURIComponent(urlObj.pathname);
      const normalized = normalizeNestedStaticPath(pathname);

      if (normalized.isLabAsset) {
        const publicPath = normalized.staticCandidatePath;
        if (serveRoot(req, res, roots.lab, normalized.labAssetRelPath, "lab", publicPath)) return;
        if (
          serveRoot(
            req,
            res,
            path.join(roots.dist, "lab-assets"),
            normalized.labAssetRelPath,
            "dist",
            publicPath,
          )
        ) {
          return;
        }
        writePlainStaticError(res, 404, "Asset not found", undefined, req.method);
        return;
      }

      if (normalized.isAssetRequest) {
        const publicPath = normalized.staticCandidatePath.startsWith("/")
          ? normalized.staticCandidatePath
          : `/${normalized.staticCandidatePath}`;
        if (serveRoot(req, res, roots.dist, publicPath, "dist", publicPath)) return;
        if (serveRoot(req, res, roots.publicDir, publicPath, "public", publicPath)) return;
        if (serveRoot(req, res, roots.project, publicPath, "project", publicPath)) return;
        writePlainStaticError(res, 404, "Static asset not found", undefined, req.method);
        return;
      }

      const isSpaRoute =
        pathname === "/" ||
        pathname === "/play" ||
        pathname === "/docs" ||
        pathname === "/docs/" ||
        pathname === "/leaderboard" ||
        pathname === "/leaderboard/" ||
        /^\/(?:result|nft)\/[^/]+\/?$/.test(pathname);

      if (!isSpaRoute) {
        const publicPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
        if (serveRoot(req, res, roots.dist, pathname, "dist", publicPath)) return;
        if (serveRoot(req, res, roots.publicDir, pathname, "public", publicPath)) return;
      }

      if (serveRoot(req, res, roots.dist, "index.html", "dist", "/index.html", true)) return;
      if (serveRoot(req, res, roots.project, "index.html", "project", "/index.html", true)) return;

      writePlainStaticError(res, 404, "Not found", undefined, req.method);
    } catch (err) {
      if (res.headersSent) return;
      const message = err instanceof Error ? err.message : "Internal server error";
      writePlainStaticError(
        res,
        500,
        JSON.stringify({ error: message }),
        "application/json; charset=utf-8",
        req.method,
      );
    }
  });

  return { backend, server };
}

// Run standalone if invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || "127.0.0.1";
  const { server, backend } = createHatcheryHttpServer({
    dbPath: process.env.SQUEEK_DB_PATH,
  });
  server.listen(port, host, () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    console.log(`Squeek LED Hatchery server listening on http://${host}:${actualPort}`);
  });
  process.on("SIGINT", () => {
    server.close();
    backend.close();
    process.exit(0);
  });
}
