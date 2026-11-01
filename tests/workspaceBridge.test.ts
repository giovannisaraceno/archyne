import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SRC = readFileSync(resolve(import.meta.dirname, "../bin/workspace-bridge.js"), "utf8");
const ROOT = "/work/proj";

type Bridge = Record<string, (...a: any[]) => any> & { workspace: unknown };
const g = globalThis as any;

let disk: Map<string, { content: string; mtimeMs: number }>;
let calls: Array<{ method: string; url: string; headers: any; body?: string }>;

function reply(status: number, body: unknown = {}) {
  return Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(body) });
}

function fakeFetch(url: string, init: any = {}) {
  calls.push({ method: init.method, url, headers: init.headers, body: init.body });
  const u = new URL(url, "http://x");
  const path = u.searchParams.get("path") ?? "";
  if (u.pathname === "/__archyne/list") {
    const files = [...disk.keys()]
      .sort()
      .map((p) => ({ path: p, mtimeMs: disk.get(p)!.mtimeMs }));
    return reply(200, { files });
  }
  const f = disk.get(path);
  if (u.pathname === "/__archyne/stat")
    return f ? reply(200, { mtimeMs: f.mtimeMs }) : reply(404);
  if (init.method === "PUT") {
    const base = u.searchParams.get("base");
    if (base !== null && f && f.mtimeMs > Number(base)) return reply(409);
    disk.set(path, { content: init.body, mtimeMs: 100 });
    return reply(200, { mtimeMs: 100 });
  }
  return f ? reply(200, { path, content: f.content, mtimeMs: f.mtimeMs }) : reply(404);
}

function load(search = "", autosave = true): Bridge {
  window.history.replaceState(null, "", "/" + search);
  g.__archyneWorkspace = { token: "tok", root: ROOT, autosave };
  delete g.archyne;
  (0, eval)(SRC);
  return g.archyne;
}

function put(...names: string[]) {
  for (const n of names) disk.set(n, { content: "graph TD\n" + n, mtimeMs: 1 });
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  disk = new Map();
  calls = [];
  vi.useFakeTimers();
  g.fetch = vi.fn(fakeFetch);
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.useRealTimers();
  delete g.archyne;
  delete g.__archyneWorkspace;
});

describe("workspace bridge", () => {
  it("exposes workspace and omits setTheme, fetchIcons, ai", () => {
    const b = load();
    expect(b.workspace).toEqual({ root: ROOT, autosave: true });
    expect(b.setTheme).toBeUndefined();
    expect(b.fetchIcons).toBeUndefined();
    expect((b as any).ai).toBeUndefined();
  });

  it("opens the first file and delivers the others (<=5 files)", async () => {
    put("a.mmd", "b.mmd", "docs/c.mmd");
    const b = load();
    const first = await b.openedFile();
    expect(first.path).toBe(`${ROOT}/a.mmd`);
    const got: string[] = [];
    b.onOpenFile((f: any) => got.push(f.path));
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(got).toEqual([`${ROOT}/b.mmd`, `${ROOT}/docs/c.mmd`]);
    expect(calls[0].headers["X-Archyne-Token"]).toBe("tok");
  });

  it("honours ?file", async () => {
    put("a.mmd", "b.mmd");
    const b = load("?file=b.mmd");
    expect((await b.openedFile()).path).toBe(`${ROOT}/b.mmd`);
    const got: string[] = [];
    b.onOpenFile((f: any) => got.push(f.path));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([`${ROOT}/a.mmd`]);
  });

  it("notices a missing ?file and falls back to the first file", async () => {
    put("a.mmd");
    const b = load("?file=nope.mmd");
    expect((await b.openedFile()).path).toBe(`${ROOT}/a.mmd`);
    expect(document.querySelector("[data-archyne-notice]")).not.toBeNull();
  });

  it("asks which files to open when there are more than 5", async () => {
    put("a.mmd", "b.mmd", "c.mmd", "d.mmd", "e.mmd", "f.mmd");
    const b = load("?file=c.mmd");
    const p = b.openedFile();
    await vi.advanceTimersByTimeAsync(0);
    const boxes = [
      ...document.querySelectorAll<HTMLInputElement>("[data-archyne-dialog] input"),
    ];
    expect(boxes.map((x) => x.value)).toEqual([
      "a.mmd",
      "b.mmd",
      "c.mmd",
      "d.mmd",
      "e.mmd",
      "f.mmd",
    ]);
    expect(boxes.filter((x) => x.checked).map((x) => x.value)).toEqual(["c.mmd"]);
    boxes[0].checked = true;
    const got: string[] = [];
    b.onOpenFile((f: any) => got.push(f.path));
    [...document.querySelectorAll("button")]
      .find((x) => x.textContent === "Open selected")!
      .click();
    expect((await p).path).toBe(`${ROOT}/c.mmd`);
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([`${ROOT}/a.mmd`]);
    // unselected files count as seen: no delivery from polling
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toEqual([`${ROOT}/a.mmd`]);
    put("new.mmd");
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toEqual([`${ROOT}/a.mmd`, `${ROOT}/new.mmd`]);
  });

  it("Empty tab delivers nothing", async () => {
    put("a.mmd", "b.mmd", "c.mmd", "d.mmd", "e.mmd", "f.mmd");
    const b = load();
    const p = b.openedFile();
    await vi.advanceTimersByTimeAsync(0);
    const got: string[] = [];
    b.onOpenFile((f: any) => got.push(f.path));
    [...document.querySelectorAll("button")]
      .find((x) => x.textContent === "Empty tab")!
      .click();
    expect(await p).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([]);
  });

  it("skips the dialog when tabs under root are stored, delivering only ?file", async () => {
    put("a.mmd", "b.mmd", "c.mmd", "d.mmd", "e.mmd", "f.mmd");
    localStorage.setItem(
      "graph:workspace",
      JSON.stringify({ v: 1, activeId: "1", docs: [{ id: "1", path: `${ROOT}/a.mmd` }] }),
    );
    const b = load("?file=b.mmd");
    expect((await b.openedFile()).path).toBe(`${ROOT}/b.mmd`);
    const got: string[] = [];
    b.onOpenFile((f: any) => got.push(f.path));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector("[data-archyne-dialog]")).toBeNull();
    expect(got).toEqual([]);
  });

  it("showOpen shows the list dialog", async () => {
    put("a.mmd", "b.mmd");
    const b = load();
    const p = b.showOpen();
    await vi.advanceTimersByTimeAsync(0);
    const boxes = [
      ...document.querySelectorAll<HTMLInputElement>("[data-archyne-dialog] input"),
    ];
    boxes[1].checked = true;
    [...document.querySelectorAll("button")]
      .find((x) => x.textContent === "Open selected")!
      .click();
    expect((await p).path).toBe(`${ROOT}/b.mmd`);
  });

  it("showSave prompts, validates the extension and PUTs without base", async () => {
    const b = load();
    g.prompt = vi.fn(() => "docs/x.mmd");
    expect(await b.showSave("x.mmd", "graph TD")).toBe(`${ROOT}/docs/x.mmd`);
    const put1 = calls.find((c) => c.method === "PUT")!;
    expect(put1.url).toContain("path=docs%2Fx.mmd");
    expect(put1.url).not.toContain("base=");
    g.prompt = vi.fn(() => "x.txt");
    await expect(b.showSave("x.mmd", "g")).rejects.toThrow();
    g.prompt = vi.fn(() => null);
    expect(await b.showSave("x.mmd", "g")).toBeNull();
  });

  it("file calls: write with base, conflict, stat, read", async () => {
    put("a.mmd");
    const b = load();
    expect(await b.writeFile(`${ROOT}/a.mmd`, "x", { base: 5 })).toEqual({ mtimeMs: 100 });
    expect(calls.at(-1)!.url).toContain("base=5");
    await expect(b.writeFile(`${ROOT}/a.mmd`, "y", { base: 5 })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await b.statFile(`${ROOT}/a.mmd`)).toEqual({ mtimeMs: 100 });
    expect(await b.statFile(`${ROOT}/none.mmd`)).toBeNull();
    expect(await b.readFile(`${ROOT}/a.mmd`)).toBe("x");
    expect(await b.readFile(`${ROOT}/none.mmd`)).toBeNull();
  });
});
