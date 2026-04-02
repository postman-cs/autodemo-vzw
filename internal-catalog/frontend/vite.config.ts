import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const frontendRoot = path.resolve(__dirname);
const repoRoot = path.resolve(__dirname, "..");
const specsRoot = path.resolve(repoRoot, "specs");
const localDevAuthMode = String(process.env.LOCAL_DEV_AUTH_MODE ?? "") === "bypass" ? "bypass" : "strict";
export const LOCAL_DEV_IDLE_TIMEOUT_MS = 0; // 0 = disabled (no idle shutdown)

export function shouldExitForIdle(args: {
  lastActivityAt: number;
  now: number;
  timeoutMs?: number;
}): boolean {
  const timeoutMs = args.timeoutMs ?? LOCAL_DEV_IDLE_TIMEOUT_MS;
  if (timeoutMs <= 0) return false;
  return args.now - args.lastActivityAt >= timeoutMs;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".yaml":
    case ".yml":
      return "application/yaml; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function warnLocalDevMode(): Plugin {
  return {
    name: "warn-local-dev-mode",
    configureServer(server) {
      server.config.logger.warn("Local dev mode: real worker actions enabled");
    },
  };
}

function idleShutdownPlugin(timeoutMs = LOCAL_DEV_IDLE_TIMEOUT_MS): Plugin {
  return {
    name: "idle-shutdown",
    configureServer(server) {
      let lastActivityAt = Date.now();
      let isClosing = false;

      const markActivity = () => {
        lastActivityAt = Date.now();
      };

      const closeForIdle = async () => {
        if (isClosing) return;
        isClosing = true;
        server.config.logger.warn(`Local dev idle timeout reached after ${timeoutMs / 60000}m; shutting down.`);
        await server.close();
        process.exit(0);
      };

      const idleInterval = setInterval(() => {
        if (shouldExitForIdle({ lastActivityAt, now: Date.now(), timeoutMs })) {
          void closeForIdle();
        }
      }, 30_000);

      if (typeof idleInterval.unref === "function") {
        idleInterval.unref();
      }

      server.middlewares.use((_req, _res, next) => {
        markActivity();
        next();
      });

      server.httpServer?.on("upgrade", markActivity);
      server.httpServer?.once("close", () => {
        clearInterval(idleInterval);
      });
    },
  };
}

export function resolveDevSpecFilePath(pathname: string): string | null {
  if (!pathname.startsWith("/specs/")) return null;

  const relativePath = pathname.slice("/specs/".length);
  if (!relativePath || relativePath.includes("\0")) return null;

  const targetPath = path.resolve(specsRoot, relativePath);
  const relativeFromSpecsRoot = path.relative(specsRoot, targetPath);
  if (relativeFromSpecsRoot.startsWith("..") || path.isAbsolute(relativeFromSpecsRoot)) {
    return null;
  }

  if (!existsSync(targetPath)) return null;
  if (!statSync(targetPath).isFile()) return null;

  return targetPath;
}

function serveSpecsInDev(): Plugin {
  return {
    name: "serve-specs-in-dev",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url || "/";
        const pathname = rawUrl.split("?")[0] || "/";
        const targetPath = resolveDevSpecFilePath(pathname);
        if (!targetPath) {
          next();
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", contentTypeFor(targetPath));
        res.end(readFileSync(targetPath));
      });
    },
  };
}

function copySpecs(): Plugin {
  return {
    name: "copy-specs",
    closeBundle() {
      cpSync(
        path.resolve(repoRoot, "specs"),
        path.resolve(repoRoot, "public/client/specs"),
        { recursive: true },
      );
    },
  };
}

export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
    hmr: { overlay: false },
  },
  plugins: [
    react(),
    cloudflare({
      configPath: path.resolve(repoRoot, "wrangler.toml"),
      config: {
        vars: {
          LOCAL_DEV_AUTH_MODE: localDevAuthMode,
        },
      },
    }),
    warnLocalDevMode(),
    idleShutdownPlugin(),
    serveSpecsInDev(),
    copySpecs(),
  ],
  root: frontendRoot,
  build: {
    outDir: path.resolve(repoRoot, "public"),
    emptyOutDir: true,
  },
});
