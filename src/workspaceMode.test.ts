import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGraphStore, loadInitialCode } from "./store";
import { useFileStore } from "./files";
import { adoptBackgroundFileHere, adoptFileHere, bindActiveDocument, switchTo } from "./documents";
import { DOC_PREFIX, INDEX_KEY, loadWorkspace, useWorkspace } from "./workspace";
import { AUTOSAVE_MS, startAutosave } from "./autosave";
import { resetWatched, setBase } from "./diskWatch";

// ELK is the slow step in a browser; under jsdom it is quick enough to hide
// the race below. One test slows it down to the order a browser runs in.
const layout = vi.hoisted(() => ({ delayMs: 0 }));
vi.mock("./layout/autoLayout", async (importOriginal) => {
  const real = await importOriginal<typeof import("./layout/autoLayout")>();
  return {
    ...real,
    autoLayout: async (...args: Parameters<typeof real.autoLayout>) => {
      if (layout.delayMs) await new Promise((r) => setTimeout(r, layout.delayMs));
      return real.autoLayout(...args);
    },
  };
});

const A = `flowchart TD\n  a["A"] --> b["B"]\n`;
const B = `flowchart LR\n  x["X"] --> y["Y"]\n`;
const ROOT = "/work/proj";

function setWorkspace(on: boolean) {
  (globalThis as { archyne?: unknown }).archyne = on
    ? { workspace: { root: ROOT, autosave: true } }
    : undefined;
}

function seed(docs: Array<{ id: string; path: string | null }>) {
  localStorage.setItem(
    INDEX_KEY,
    JSON.stringify({
      v: 1,
      activeId: docs[0].id,
      docs: docs.map((d) => ({
        id: d.id,
        name: d.id,
        updatedAt: 1,
        path: d.path,
        savedCode: d.path ? A : null,
      })),
    }),
  );
  for (const d of docs) localStorage.setItem(DOC_PREFIX + d.id, A);
}

async function boot() {
  const { state, code } = loadWorkspace(loadInitialCode());
  useWorkspace.setState(state);
  bindActiveDocument();
  await useGraphStore.getState().applyCode(code, { record: false });
}

beforeEach(() => {
  localStorage.clear();
  useWorkspace.setState({ docs: [], activeId: "" });
  useFileStore.setState({ name: null, path: null, handle: null, savedCode: null });
});
afterEach(() => setWorkspace(false));

describe("workspace mode", () => {
  it("prunes docs outside root, keeps scratch, separator-aware", () => {
    setWorkspace(true);
    seed([
      { id: "in", path: `${ROOT}/a.mmd` },
      { id: "out", path: "/other/b.mmd" },
      { id: "sib", path: `${ROOT}2/c.mmd` },
      { id: "scratch", path: null },
    ]);
    const { state } = loadWorkspace("x");
    expect(state.docs.map((d) => d.id)).toEqual(["in", "scratch"]);
    expect(localStorage.getItem(DOC_PREFIX + "out")).toBeNull();
  });

  it("falls back to one blank doc when nothing remains", () => {
    setWorkspace(true);
    seed([{ id: "out", path: "/other/b.mmd" }]);
    const { state, code } = loadWorkspace("fallback");
    expect(state.docs).toHaveLength(1);
    expect(state.docs[0].path).toBeNull();
    expect(code).toBe("fallback");
  });

  it("does not prune without workspace", () => {
    seed([{ id: "out", path: "/other/b.mmd" }]);
    expect(loadWorkspace("x").state.docs.map((d) => d.id)).toEqual(["out"]);
  });

  it("dedups by path and names tabs relatively", async () => {
    setWorkspace(true);
    await boot();
    await adoptFileHere({ path: `${ROOT}/docs/a.mmd`, content: A });
    const first = useWorkspace.getState().activeId;
    expect(useWorkspace.getState().docs.find((d) => d.id === first)?.name).toBe("docs/a.mmd");
    await adoptBackgroundFileHere({ path: `${ROOT}/b.mmd`, content: B });
    const n = useWorkspace.getState().docs.length;
    await adoptFileHere({ path: `${ROOT}/b.mmd`, content: B });
    expect(useWorkspace.getState().docs).toHaveLength(n);
    expect(useGraphStore.getState().code).toBe(B);
    await adoptFileHere({ path: `${ROOT}/docs/a.mmd`, content: A });
    expect(useWorkspace.getState().activeId).toBe(first);
    expect(useWorkspace.getState().docs).toHaveLength(n);
  });

  it("reuses the restored file tab when the same file is opened again after a reload", async () => {
    setWorkspace(true);
    seed([{ id: "wf", path: `${ROOT}/WORKFLOW.mmd` }]);
    await boot();
    // ?file=WORKFLOW.mmd on every page load: the restored tab must take it.
    await adoptFileHere({ path: `${ROOT}/WORKFLOW.mmd`, content: B });
    const s = useWorkspace.getState();
    expect(s.docs).toHaveLength(1);
    expect(s.activeId).toBe("wf");
    expect(useFileStore.getState().path).toBe(`${ROOT}/WORKFLOW.mmd`);
  });

  it("keeps the file binding of the restored tab when the user switches away", async () => {
    setWorkspace(true);
    seed([
      { id: "wf", path: `${ROOT}/WORKFLOW.mmd` },
      { id: "x", path: `${ROOT}/x.mmd` },
    ]);
    await boot();
    await switchTo("x");
    const wf = useWorkspace.getState().docs.find((d) => d.id === "wf");
    expect(wf?.path).toBe(`${ROOT}/WORKFLOW.mmd`);
    expect(wf?.savedCode).toBe(A);
  });

  it("opens background files in a new inactive tab, once", async () => {
    setWorkspace(true);
    await boot();
    const active = useWorkspace.getState().activeId;
    const n = useWorkspace.getState().docs.length;
    await adoptBackgroundFileHere({ path: `${ROOT}/n.mmd`, content: B });
    await adoptBackgroundFileHere({ path: `${ROOT}/n.mmd`, content: B });
    const s = useWorkspace.getState();
    expect(s.docs).toHaveLength(n + 1);
    expect(s.activeId).toBe(active);
    expect(s.docs.at(-1)?.name).toBe("n.mmd");
  });

  it("keeps basenames and duplicates without workspace", async () => {
    await boot();
    await adoptFileHere({ path: "/x/y/a.mmd", content: A });
    expect(useWorkspace.getState().docs.find((d) => d.path)?.name).toBe("a.mmd");
    await adoptFileHere({ path: "/x/y/a.mmd", content: B });
    expect(useWorkspace.getState().docs.filter((d) => d.path === "/x/y/a.mmd").length).toBe(2);
  });

  it("loads a file with a positions line over the boot document, and autosave leaves it alone", async () => {
    // The shape of `archyne --root <dir>` with `?file=<name>`: the app applies
    // the document it had (no positions, so ELK runs) without waiting, while
    // the shell hands over the file. The file skips ELK and used to finish
    // first; the boot document then landed on top, under the file's path,
    // and autosave wrote it over the file about a second later.
    const withPos = `flowchart LR
  a["Alpha"] --> b["Beta"]
%% graph:positions {"a":{"x":0,"y":0},"b":{"x":200,"y":0}}
`;
    const path = `${ROOT}/with-pos.mmd`;
    const writeFile = vi.fn(async () => ({ mtimeMs: 2 }));
    (globalThis as { archyne?: unknown }).archyne = {
      workspace: { root: ROOT, autosave: true },
      writeFile,
      statFile: async () => ({ mtimeMs: 1 }),
    };
    seed([{ id: "old", path: `${ROOT}/old.mmd` }]);
    // A fresh page: nothing on screen yet, nothing bound.
    useGraphStore.setState({ code: "", nodes: [], edges: [], parseError: null });
    resetWatched();
    const stop = startAutosave();
    layout.delayMs = 200;
    try {
      const { state, code } = loadWorkspace(loadInitialCode());
      useWorkspace.setState(state);
      const booting = useGraphStore.getState().applyCode(code, { record: false });
      const adopting = adoptFileHere({ path, content: withPos });
      await Promise.all([booting, adopting]);
      setBase(useWorkspace.getState().activeId, 1);

      expect(useGraphStore.getState().code).toBe(withPos);
      expect(useGraphStore.getState().nodes.map((n) => n.data.label)).toEqual([
        "Alpha",
        "Beta",
      ]);
      expect(useFileStore.getState().path).toBe(path);

      await new Promise((r) => setTimeout(r, AUTOSAVE_MS + 300));
      expect(writeFile).not.toHaveBeenCalled();
    } finally {
      layout.delayMs = 0;
      stop();
    }
  });
});
