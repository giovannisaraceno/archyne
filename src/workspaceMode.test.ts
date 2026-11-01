import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useGraphStore, loadInitialCode } from "./store";
import { useFileStore } from "./files";
import { adoptBackgroundFileHere, adoptFileHere } from "./documents";
import { DOC_PREFIX, INDEX_KEY, loadWorkspace, useWorkspace } from "./workspace";

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
});
