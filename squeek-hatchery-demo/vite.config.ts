import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { HatcheryBackend } from "./src/backend.ts";
import { writePlainStaticError } from "./src/static-cache.ts";
import { normalizeNestedStaticPath, tryServeStaticFile } from "./src/server.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LAB_ASSETS_ROOT = path.resolve(__dirname, "../hamster-trait-lab/assets");
const DEFAULT_DB_PATH = path.resolve(__dirname, "cache", "hatchery-backend.sqlite");

function squeekHatcheryPlugin(): Plugin {
  let backend: HatcheryBackend | null = null;
  const getBackend = () => {
    if (!backend) {
      backend = new HatcheryBackend({
        dbPath: process.env.SQUEEK_DB_PATH || DEFAULT_DB_PATH,
      });
    }
    return backend;
  };

  const attachMiddleware = (middlewares: {
    use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void;
  }) => {
    middlewares.use(async (req, res, next) => {
      try {
        const url = req.url ?? "/";
        if (url.startsWith("/api/")) {
          const handled = await getBackend().handleApiRequest(req, res);
          if (handled) return;
        }
        const [rawPathname, queryPart] = url.split("?");
        const pathname = decodeURIComponent(rawPathname || "/");
        const normalized = normalizeNestedStaticPath(pathname);

        if (normalized.isLabAsset) {
          if (
            tryServeStaticFile(LAB_ASSETS_ROOT, normalized.labAssetRelPath, res, req, {
              rootKind: "lab",
              publicPath: normalized.staticCandidatePath,
            })
          ) {
            return;
          }
          writePlainStaticError(res, 404, "Asset not found", undefined, req.method);
          return;
        }

        if (normalized.isAssetRequest && normalized.staticCandidatePath !== pathname) {
          req.url =
            normalized.staticCandidatePath + (queryPart ? `?${queryPart}` : "");
        }
        next();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Middleware error";
        writePlainStaticError(res, 500, JSON.stringify({ error: message }), "application/json; charset=utf-8", req.method);
      }
    });
  };

  return {
    name: "squeek-hatchery-backend-and-lab-assets",
    configureServer(server) {
      attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [squeekHatcheryPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
