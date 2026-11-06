import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HatcheryBackend, type BackendOptions } from "./backend.ts";

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

export function tryServeStaticFile(
  rootDir: string,
  relativePath: string,
  res: ServerResponse,
): boolean {
  const safeRel = relativePath.replace(/^[/\\]+/, "");
  const resolved = path.resolve(rootDir, safeRel);
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (resolved !== rootDir && !resolved.startsWith(rootWithSep)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }
  if (!fs.existsSync(resolved)) {
    return false;
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    return false;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(fs.readFileSync(resolved));
  return true;
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

export function createHatcheryHttpServer(options: BackendOptions = {}): {
  backend: HatcheryBackend;
  server: http.Server;
} {
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
        if (tryServeStaticFile(LAB_ASSETS_ROOT, normalized.labAssetRelPath, res)) return;
        if (
          tryServeStaticFile(
            path.join(DIST_ROOT, "lab-assets"),
            normalized.labAssetRelPath,
            res,
          )
        ) {
          return;
        }
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Asset not found");
        return;
      }

      if (normalized.isAssetRequest) {
        if (tryServeStaticFile(DIST_ROOT, normalized.staticCandidatePath, res)) return;
        if (tryServeStaticFile(PUBLIC_ROOT, normalized.staticCandidatePath, res)) return;
        if (tryServeStaticFile(PROJECT_ROOT, normalized.staticCandidatePath, res)) return;
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Static asset not found");
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
        if (tryServeStaticFile(DIST_ROOT, pathname, res)) return;
        if (tryServeStaticFile(PUBLIC_ROOT, pathname, res)) return;
      }

      // SPA fallback to dist/index.html or index.html for app routes
      if (tryServeStaticFile(DIST_ROOT, "index.html", res)) return;
      if (tryServeStaticFile(PROJECT_ROOT, "index.html", res)) return;

      res.statusCode = 404;
      res.end("Not found");
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : "Internal server error",
        }),
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
