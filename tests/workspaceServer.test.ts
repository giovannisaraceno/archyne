// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, utimesSync, existsSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorkspaceServer } from "../bin/workspace.mjs";

let tmp: string, root: string, outside: string, ws: any;

const INDEX = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' blob:;"></head><body><script type="module" src="/app.js"></script></body></html>`;

function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: string; token?: boolean } = {}) {
  return new Promise<{ status: number; headers: any; text: string; json: () => any }>((ok, bad) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${ws.port}`, ...(opts.headers ?? {}) };
    if (opts.token !== false) headers["x-archyne-token"] = ws.token;
    const req = request({ host: "127.0.0.1", port: ws.port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on("error", bad);
    req.end(opts.body);
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "archyne-ws-"));
  root = join(tmp, "root");
  outside = join(tmp, "outside");
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".hidden"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "b.mmd"), "graph TD; B-->C");
  writeFileSync(join(root, "a.mermaid"), "graph TD; A-->B");
  writeFileSync(join(root, "sub", "c.mmd"), "graph TD; C-->D");
  writeFileSync(join(root, "node_modules", "x.mmd"), "x");
  writeFileSync(join(root, ".git", "x.mmd"), "x");
  writeFileSync(join(root, ".hidden", "x.mmd"), "x");
  writeFileSync(join(root, "notes.txt"), "txt");
  writeFileSync(join(outside, "secret.mmd"), "secret");
  symlinkSync(outside, join(root, "link"));
  symlinkSync(join(outside, "secret.mmd"), join(root, "evil.mmd"));
  const dist = join(tmp, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), INDEX);
  writeFileSync(join(dist, "app.js"), "//app");
  writeFileSync(join(tmp, "bridge.js"), "// bridge");
  ws = await startWorkspaceServer({ root, port: 0, autosave: true, distDir: dist, bridgePath: join(tmp, "bridge.js") });
});
afterAll(async () => {
  await ws.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("index.html", () => {
  it("injects nonce config, CSP nonce and bridge before the app script", async () => {
    const r = await call("GET", "/", { token: false });
    expect(r.status).toBe(200);
    const nonce = /<script nonce="([^"]+)">/.exec(r.text)![1];
    expect(r.text).toContain(`'nonce-${nonce}'`);
    expect(r.text).toContain(`"token":"${ws.token}"`);
    expect(r.text).toContain(`"autosave":true`);
    const iCfg = r.text.indexOf("__archyneWorkspace");
    const iBridge = r.text.indexOf('src="/__archyne/bridge.js"');
    const iApp = r.text.indexOf('type="module"');
    expect(iCfg).toBeLessThan(iBridge);
    expect(iBridge).toBeLessThan(iApp);
  });
  it("serves static files", async () => {
    expect((await call("GET", "/app.js", { token: false })).text).toBe("//app");
    expect((await call("GET", "/missing.js", { token: false })).status).toBe(404);
  });
});

describe("API", () => {
  it("lists files sorted, ignoring node_modules/.git/hidden and symlinks", async () => {
    const r = await call("GET", "/__archyne/list");
    expect(r.status).toBe(200);
    expect(r.json().files.map((f: any) => f.path)).toEqual(["a.mermaid", "b.mmd", "sub/c.mmd"]);
    expect(typeof r.json().files[0].mtimeMs).toBe("number");
  });
  it("reads and stats", async () => {
    const r = await call("GET", "/__archyne/file?path=sub/c.mmd");
    expect(r.json()).toMatchObject({ path: "sub/c.mmd", content: "graph TD; C-->D" });
    expect((await call("GET", "/__archyne/stat?path=b.mmd")).json().mtimeMs).toBeGreaterThan(0);
    expect((await call("GET", "/__archyne/stat?path=nope.mmd")).status).toBe(404);
    expect((await call("GET", "/__archyne/file?path=nope.mmd")).status).toBe(404);
  });
  it("PUT writes atomically, honours base, and always writes without base", async () => {
    const put = (q: string, body: string) => call("PUT", `/__archyne/file?${q}`, { body });
    const created = await put("path=new/d.mmd", "graph TD; X-->Y");
    expect(created.status).toBe(200);
    expect(readFileSync(join(root, "new/d.mmd"), "utf8")).toBe("graph TD; X-->Y");
    const m1 = created.json().mtimeMs;
    expect((await put(`path=new/d.mmd&base=${m1}`, "v2")).status).toBe(200);
    utimesSync(join(root, "new/d.mmd"), new Date(), new Date(Date.now() + 60_000));
    expect((await put(`path=new/d.mmd&base=${m1}`, "v3")).status).toBe(409);
    expect(readFileSync(join(root, "new/d.mmd"), "utf8")).toBe("v2");
    expect((await put("path=new/d.mmd", "v4")).status).toBe(200);
    expect(readFileSync(join(root, "new/d.mmd"), "utf8")).toBe("v4");
    expect((await put("path=new/d.mmd&base=abc", "v5")).status).toBe(400);
  });
  it("rejects oversize bodies with 413 and bad input with 400", async () => {
    expect((await call("PUT", "/__archyne/file?path=big.mmd", { body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect(existsSync(join(root, "big.mmd"))).toBe(false);
    expect((await call("GET", "/__archyne/file")).status).toBe(400);
  });
});

describe("security", () => {
  it("requires the token", async () => {
    expect((await call("GET", "/__archyne/list", { token: false })).status).toBe(403);
    expect((await call("GET", "/__archyne/list", { token: false, headers: { "x-archyne-token": "bad" } })).status).toBe(403);
  });
  it("serves bridge.js without a token", async () => {
    const r = await call("GET", "/__archyne/bridge.js", { token: false });
    expect(r.status).toBe(200);
    expect(r.text).toBe("// bridge");
  });
  it("rejects foreign Host, foreign Origin and OPTIONS; never sends CORS headers", async () => {
    expect((await call("GET", "/__archyne/list", { headers: { host: "evil.com" } })).status).toBe(403);
    expect((await call("GET", "/__archyne/list", { headers: { host: `localhost:${ws.port}` } })).status).toBe(200);
    expect((await call("GET", "/__archyne/list", { headers: { origin: "http://evil.com" } })).status).toBe(403);
    const ok = await call("GET", "/__archyne/list", { headers: { origin: `http://127.0.0.1:${ws.port}` } });
    expect(ok.status).toBe(200);
    const opt = await call("OPTIONS", "/__archyne/list");
    expect(opt.status).toBe(403);
    for (const r of [ok, opt]) expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
  });
  it("confines paths to root", async () => {
    for (const p of ["../x.mmd", "..%2Foutside%2Fsecret.mmd", "link/secret.mmd", "evil.mmd", "/etc/passwd.mmd"]) {
      expect((await call("GET", `/__archyne/file?path=${p}`)).status).toBe(403);
    }
    expect((await call("PUT", "/__archyne/file?path=link/new.mmd", { body: "x" })).status).toBe(403);
    expect((await call("PUT", "/__archyne/file?path=evil.mmd", { body: "x" })).status).toBe(403);
    expect(readFileSync(join(outside, "secret.mmd"), "utf8")).toBe("secret");
    expect(existsSync(join(outside, "new.mmd"))).toBe(false);
  });
  it("only allows .mmd and .mermaid", async () => {
    expect((await call("PUT", "/__archyne/file?path=notes.txt", { body: "x" })).status).toBe(403);
    expect((await call("PUT", "/__archyne/file?path=x.js", { body: "x" })).status).toBe(403);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("txt");
  });
  it("offers no way to delete", async () => {
    expect((await call("DELETE", "/__archyne/file?path=b.mmd")).status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(root, "b.mmd"))).toBe(true);
  });
});
