// @vitest-environment node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = resolve(import.meta.dirname, "../bin/archyne.mjs");
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "archyne-cli-"));
  writeFileSync(join(dir, "a.mmd"), "graph TD; A-->B");
  writeFileSync(join(dir, "file.txt"), "x");
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "index.html"), "<html><head></head><body></body></html>");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], { waitFor, timeoutMs = 15000 }: { waitFor?: RegExp; timeoutMs?: number } = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((ok) => {
    const p = spawn(process.execPath, [BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ARCHYNE_DIST: join(dir, "dist") },
    });
    let out = "", err = "";
    const done = (code: number | null) => { clearTimeout(t); ok({ code, out, err }); };
    const t = setTimeout(() => { p.kill(); }, timeoutMs);
    p.stdout.on("data", (c) => { out += c; if (waitFor?.test(out)) { p.kill(); } });
    p.stderr.on("data", (c) => (err += c));
    p.on("exit", (code) => done(code));
  });
}

describe("archyne CLI argument errors", () => {
  it("--root with --host exits non-zero", async () => {
    const r = await run(["--root", dir, "--host", "--no-open"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--host/);
  });
  it("missing root exits non-zero", async () => {
    expect((await run(["--root", join(dir, "nope"), "--no-open"])).code).not.toBe(0);
  });
  it("non-directory root exits non-zero", async () => {
    expect((await run(["--root", join(dir, "file.txt"), "--no-open"])).code).not.toBe(0);
  });
  it("mcp without --root exits non-zero", async () => {
    expect((await run(["mcp"])).code).not.toBe(0);
  });
  it("without --root port validation is unchanged (port 0 rejected)", async () => {
    const r = await run(["--port", "0", "--no-open"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Not a usable port: 0");
  });
});

describe("archyne --root", () => {
  it("prints the ready line with the real port for --port 0", async () => {
    const r = await run(["--root", dir, "--port", "0", "--no-open"], { waitFor: /Archyne running at .*\n/ });
    expect(r.out).toMatch(/^Archyne running at http:\/\/127\.0\.0\.1:\d+\/\n/);
    expect(r.out).not.toContain(":0/");
  });
  it("--no-autosave sets autosave false in the served config", async () => {
    for (const [flags, want] of [[[], "true"], [["--no-autosave"], "false"]] as const) {
      const r = await new Promise<string>((ok) => {
        const p = spawn(process.execPath, [BIN, "--root", dir, "--port", "0", "--no-open", ...flags], {
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, ARCHYNE_DIST: join(dir, "dist") },
        });
        let out = "";
        p.stdout.on("data", async (c) => {
          out += c;
          const m = /127\.0\.0\.1:(\d+)/.exec(out);
          if (m) {
            const res = await fetch(`http://127.0.0.1:${m[1]}/`);
            ok(await res.text());
            p.kill();
          }
        });
      });
      expect(r).toContain(`"autosave":${want}`);
    }
  });
  it("exits non-zero when the port is busy", async () => {
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(0, "127.0.0.1", ok));
    const port = (blocker.address() as any).port;
    try {
      expect((await run(["--root", dir, "--port", String(port), "--no-open"])).code).not.toBe(0);
    } finally {
      blocker.close();
    }
  });
});
