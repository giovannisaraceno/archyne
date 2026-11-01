// @ts-nocheck
/**
 * Archyne workspace mode server: serves dist/ with an injected bridge and a
 * small local API (/__archyne/) over the files of one root directory.
 *
 * Security model (see docs spec 01): 127.0.0.1 only, Host allowlist against
 * DNS rebinding, per-process token for the API, no CORS at all, paths confined
 * to the root by realpath, only .mmd/.mermaid, 1 MB limit, nothing is deleted.
 */
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
  mkdir,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  extname,
  join,
  normalize,
  resolve,
  sep,
  relative,
  isAbsolute,
} from "node:path";

const MAX_BYTES = 1024 * 1024;
const MAX_LIST = 500;
const API = "/__archyne/";
const EXT = new Set([".mmd", ".mermaid"]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message ?? String(status));
    this.status = status;
  }
}

const inside = (base, p) => p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Inject the nonce'd config script and the bridge before the app module. */
export function injectWorkspace(html, { token, root, autosave, nonce }) {
  const cfg = JSON.stringify({ token, root, autosave }).replace(/</g, "\\u003c");
  const tags =
    `<script nonce="${nonce}">globalThis.__archyneWorkspace = ${cfg};</script>\n` +
    `<script src="/__archyne/bridge.js"></script>\n`;
  let out = html.replace(/(script-src)(\s+)'self'/, `$1$2'self' 'nonce-${nonce}'`);
  const m = /<script\b[^>]*type=["']module["'][^>]*>/i.exec(out);
  if (m) return out.slice(0, m.index) + tags + out.slice(m.index);
  const head = out.indexOf("</head>");
  return head >= 0 ? out.slice(0, head) + tags + out.slice(head) : tags + out;
}

export async function startWorkspaceServer({
  root,
  port = 0,
  autosave = true,
  distDir,
  bridgePath,
}) {
  const realRoot = await realpath(resolve(root));
  if (!(await stat(realRoot)).isDirectory()) throw new Error(`Not a directory: ${root}`);
  const dist = resolve(distDir);
  const token = randomBytes(24).toString("hex");
  const nonce = randomBytes(16).toString("base64");
  let boundPort = 0;

  const send = (res, status, body, type = "text/plain; charset=utf-8", extra = {}) => {
    const buf = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": typeof body === "string" ? type : "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    });
    res.end(buf);
  };

  /** Resolve an API path to a real absolute path inside root, or throw. */
  async function resolvePath(rel, { mustExist }) {
    if (typeof rel !== "string" || rel === "" || rel.includes("\0"))
      throw new HttpError(400, "Bad path");
    if (isAbsolute(rel)) throw new HttpError(403, "Forbidden");
    const abs = resolve(realRoot, rel);
    if (!inside(realRoot, abs) || abs === realRoot) throw new HttpError(403, "Forbidden");
    if (!EXT.has(extname(abs).toLowerCase())) throw new HttpError(403, "Forbidden");
    // Follow symlinks on the deepest existing ancestor and re-check.
    let probe = abs;
    for (;;) {
      try {
        const real = await realpath(probe);
        if (!inside(realRoot, real)) throw new HttpError(403, "Forbidden");
        const target = probe === abs ? real : join(real, relative(probe, abs));
        if (mustExist && probe !== abs) throw new HttpError(404, "Not found");
        return target;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw new HttpError(403, "Forbidden");
        const up = dirname(probe);
        if (up === probe) throw new HttpError(403, "Forbidden");
        probe = up;
      }
    }
  }

  async function readBody(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > MAX_BYTES) throw new HttpError(413, "Too large");
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function listFiles() {
    const files = [];
    async function walk(dir) {
      if (files.length >= MAX_LIST) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (files.length >= MAX_LIST) return;
        if (e.isSymbolicLink()) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name.startsWith(".")) continue;
          await walk(full);
        } else if (e.isFile() && EXT.has(extname(e.name).toLowerCase())) {
          try {
            files.push({
              path: relative(realRoot, full).split(sep).join("/"),
              mtimeMs: (await stat(full)).mtimeMs,
            });
          } catch {}
        }
      }
    }
    await walk(realRoot);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return files.slice(0, MAX_LIST);
  }

  async function api(req, res, url) {
    if (!safeEqual(req.headers["x-archyne-token"], token))
      throw new HttpError(403, "Forbidden");
    const op = url.pathname.slice(API.length);
    const rel = url.searchParams.get("path");
    if (op === "list" && req.method === "GET")
      return send(res, 200, { files: await listFiles() });
    if (op === "stat" && req.method === "GET") {
      const p = await resolvePath(rel, { mustExist: true });
      try {
        return send(res, 200, { mtimeMs: (await stat(p)).mtimeMs });
      } catch {
        throw new HttpError(404, "Not found");
      }
    }
    if (op === "file" && req.method === "GET") {
      const p = await resolvePath(rel, { mustExist: true });
      let st;
      try {
        st = await stat(p);
      } catch {
        throw new HttpError(404, "Not found");
      }
      if (!st.isFile()) throw new HttpError(400, "Not a file");
      if (st.size > MAX_BYTES) throw new HttpError(413, "Too large");
      return send(res, 200, {
        path: rel,
        content: await readFile(p, "utf8"),
        mtimeMs: st.mtimeMs,
      });
    }
    if (op === "file" && req.method === "PUT") {
      const baseRaw = url.searchParams.get("base");
      let base = null;
      if (baseRaw !== null) {
        base = Number(baseRaw);
        if (baseRaw === "" || !Number.isFinite(base)) throw new HttpError(400, "Bad base");
      }
      const p = await resolvePath(rel, { mustExist: false });
      const body = await readBody(req);
      let existing = null;
      try {
        existing = await stat(p);
        if (!existing.isFile()) throw new HttpError(400, "Not a file");
      } catch (e) {
        if (e instanceof HttpError) throw e;
      }
      if (base !== null && existing && existing.mtimeMs > base)
        throw new HttpError(409, "Conflict");
      await mkdir(dirname(p), { recursive: true });
      // Re-check confinement now that the directory exists.
      if (!inside(realRoot, await realpath(dirname(p)))) throw new HttpError(403, "Forbidden");
      const tmp = join(dirname(p), `.${randomBytes(6).toString("hex")}.archyne-tmp`);
      try {
        await writeFile(tmp, body, { encoding: "utf8", flag: "wx" });
        await rename(tmp, p);
      } catch (e) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
      return send(res, 200, { mtimeMs: (await stat(p)).mtimeMs });
    }
    throw new HttpError(
      op === "list" || op === "stat" || op === "file" ? 405 : 404,
      "Not found",
    );
  }

  async function serveStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD")
      throw new HttpError(405, "Method not allowed");
    const requested = decodeURIComponent(url.pathname);
    const candidate = normalize(join(dist, requested === "/" ? "/index.html" : requested));
    if (!inside(dist, candidate)) throw new HttpError(403, "Forbidden");
    let body;
    try {
      body = await readFile(candidate);
    } catch {
      throw new HttpError(404, "Not found");
    }
    const isIndex = candidate === join(dist, "index.html");
    if (isIndex) {
      const html = injectWorkspace(body.toString("utf8"), {
        token,
        root: realRoot,
        autosave,
        nonce,
      });
      return send(res, 200, html, TYPES[".html"], { "cache-control": "no-store" });
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(candidate).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(body);
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") throw new HttpError(403, "Forbidden");
      const host = String(req.headers.host ?? "");
      if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`)
        throw new HttpError(403, "Forbidden");
      const origin = req.headers.origin;
      const url = new URL(req.url ?? "/", "http://localhost");
      const isApi = url.pathname.startsWith(API);
      if (origin !== undefined && isApi && origin !== `http://${host}`)
        throw new HttpError(403, "Forbidden");
      if (url.pathname === `${API}bridge.js`) {
        if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
        return send(res, 200, await readFile(bridgePath, "utf8"), TYPES[".js"]);
      }
      if (isApi) return await api(req, res, url);
      return await serveStatic(req, res, url);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent)
        send(res, status, e instanceof HttpError ? e.message : "Internal error");
      else res.end();
    }
  });

  await new Promise((ok, bad) => {
    server.once("error", bad);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", bad);
      ok();
    });
  });
  boundPort = server.address().port;
  return {
    server,
    port: boundPort,
    token,
    root: realRoot,
    close: () =>
      new Promise((ok) => (server.closeAllConnections?.(), server.close(() => ok()))),
  };
}
