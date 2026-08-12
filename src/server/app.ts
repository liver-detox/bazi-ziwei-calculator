import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const OFFLINE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'"
].join("; ");

export interface LocalServerOptions {
  staticRoot: string;
  dataRoot: string;
  sessionToken?: string;
  logger?: boolean;
  registerRoutes?: (app: FastifyInstance) => void | Promise<void>;
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function isNested(parentPath: string, candidatePath: string): boolean {
  const path = relative(resolve(parentPath), resolve(candidatePath));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

function tokensMatch(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function isAllowedLocalHost(host: string | undefined): boolean {
  return host !== undefined && /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/iu.test(host);
}

function isSameLocalOrigin(host: string, origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export async function buildLocalServer(options: LocalServerOptions): Promise<FastifyInstance> {
  const staticRoot = resolve(options.staticRoot);
  const dataRoot = resolve(options.dataRoot);
  if (isNested(staticRoot, dataRoot) || isNested(dataRoot, staticRoot)) {
    throw new Error("静态资源目录与案例数据目录必须相互分离");
  }
  const [staticRealRoot, dataRealRoot] = await Promise.all([
    realpath(staticRoot),
    realpath(dataRoot)
  ]);
  if (isNested(staticRealRoot, dataRealRoot) || isNested(dataRealRoot, staticRealRoot)) {
    throw new Error("静态资源目录与案例数据目录的真实路径必须相互分离");
  }

  const sessionToken = options.sessionToken ?? generateSessionToken();
  if (Buffer.byteLength(sessionToken, "utf8") < 32) {
    throw new Error("会话令牌至少需要 256 bit 随机强度");
  }

  const app = Fastify({ logger: options.logger ?? false });

  app.addHook("onRequest", async (request, reply) => {
    const rawUrl = request.raw.url ?? "";
    const requestPath = rawUrl.split(/[?#]/u, 1)[0];
    const host = request.headers.host;
    if (!isAllowedLocalHost(host)) {
      return reply.code(421).send({ error: "LOCAL_HOST_REQUIRED" });
    }
    const origin = request.headers.origin;
    if (origin !== undefined && (typeof origin !== "string" || !isSameLocalOrigin(host!, origin))) {
      return reply.code(403).send({ error: "SAME_ORIGIN_REQUIRED" });
    }
    const fetchSite = request.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && !["same-origin", "none"].includes(fetchSite)) {
      return reply.code(403).send({ error: "SAME_ORIGIN_REQUIRED" });
    }
    if (/%2e/iu.test(rawUrl) || requestPath.split("/").includes("..")) {
      return reply.code(404).send({ error: "NOT_FOUND" });
    }
    if (!(requestPath === "/api" || requestPath.startsWith("/api/")) || !WRITE_METHODS.has(request.method)) {
      return;
    }
    const supplied = request.headers["x-cyber-session-token"];
    if (typeof supplied !== "string" || !tokensMatch(sessionToken, supplied)) {
      return reply.code(401).send({ error: "SESSION_TOKEN_REQUIRED" });
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Content-Security-Policy", OFFLINE_CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    return payload;
  });

  app.get("/runtime-config.js", async (_request, reply) => {
    reply.type("application/javascript; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    return `globalThis.__CYBER_SAGA_RUNTIME__=Object.freeze({sessionToken:${JSON.stringify(sessionToken)}});\n`;
  });

  app.get("/api/health", async () => ({
    status: "ok",
    scope: "local-only",
    dataDirectoryIsStatic: false
  }));

  await options.registerRoutes?.(app);

  await app.register(fastifyStatic, {
    root: staticRealRoot,
    index: ["index.html"],
    wildcard: true,
    serveDotFiles: false,
    allowedPath: (pathName, root) => {
      try {
        const relativePath = pathName.replace(/^[/\\]+/u, "");
        const candidateRealPath = realpathSync(resolve(root, relativePath));
        return isNested(staticRealRoot, candidateRealPath) && !isNested(dataRealRoot, candidateRealPath);
      } catch {
        return false;
      }
    }
  });

  return app;
}
