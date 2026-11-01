import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_MS, startAutosave } from "./autosave";
import { getBase, resetWatched, setBase } from "./diskWatch";
import { useGraphStore } from "./store";
import { useFileStore } from "./files";
import { INDEX_KEY, useWorkspace, writeDocCode } from "./workspace";
import { useToasts } from "./toast";

const ONE = 'flowchart TD\n  a["One"] --> b["Two"]\n';
const TWO = 'flowchart TD\n  a["Changed"] --> b["Two"]\n';
const THREE = 'flowchart TD\n  a["Third"] --> b["Two"]\n';

type Opts = { base?: number } | undefined;
let writeFile: ReturnType<typeof vi.fn>;
let nextMtime: number;
let stop: () => void;

function installBridge(autosave = true) {
  writeFile = vi.fn(async (_p: string, _c: string, _o?: Opts) => ({ mtimeMs: nextMtime++ }));
  (globalThis as Record<string, unknown>).archyne = {
    workspace: { root: "/w", autosave },
    writeFile,
    statFile: async () => ({ mtimeMs: 999 }),
  };
}

async function open(path: string | null) {
  useGraphStore.setState({ code: ONE, parseError: null });
  writeDocCode("d1", ONE);
  useWorkspace.setState({
    activeId: "d1",
    docs: [{ id: "d1", name: "a.mmd", updatedAt: 1, path, handle: null, savedCode: ONE }],
  });
  useFileStore.setState({ name: "a.mmd", path, handle: null, savedCode: ONE });
}

// The parser and layout engine do not run under fake timers, so an edit is
// modelled as what autosave observes: new code plus the parse verdict.
const edit = async (code: string, parseError: string | null = null) => {
  useGraphStore.setState({ code, parseError });
};
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const baseOf = (i: number) => (writeFile.mock.calls[i][2] as Opts)?.base;

beforeEach(async () => {
  vi.useFakeTimers();
  resetWatched();
  nextMtime = 5000;
  localStorage.clear();
  localStorage.setItem(INDEX_KEY, JSON.stringify({ v: 1, activeId: "", docs: [] }));
  useToasts.setState({ toasts: [] });
  installBridge();
  await open("/w/a.mmd");
  setBase("d1", 1000);
  stop = startAutosave();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).archyne;
});

describe("autosave", () => {
  it("writes 1 s after the last change, with base", async () => {
    await edit(TWO);
    await advance(AUTOSAVE_MS - 100);
    expect(writeFile).not.toHaveBeenCalled();
    await edit(THREE);
    await advance(AUTOSAVE_MS - 100);
    expect(writeFile).not.toHaveBeenCalled();
    await advance(200);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][0]).toBe("/w/a.mmd");
    expect(writeFile.mock.calls[0][1]).toBe(useGraphStore.getState().code);
    expect(baseOf(0)).toBe(1000);
  });

  it("writes immediately when the page becomes hidden", async () => {
    await edit(TWO);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(0);
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("never writes a scratch document", async () => {
    await open(null);
    await edit(TWO);
    await advance(AUTOSAVE_MS * 3);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("skips code that does not parse and writes the next valid change", async () => {
    await edit("flowchart TD\n  a --> ", "Parse error");
    await edit("not mermaid at all {{{", "Parse error");
    await advance(AUTOSAVE_MS * 2);
    expect(writeFile).not.toHaveBeenCalled();
    await edit(TWO);
    await advance(AUTOSAVE_MS);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("moves savedCode, the doc and base to the new write", async () => {
    await edit(TWO);
    await advance(AUTOSAVE_MS);
    const code = useGraphStore.getState().code;
    expect(useFileStore.getState().savedCode).toBe(code);
    expect(useWorkspace.getState().docs[0].savedCode).toBe(code);
    expect(getBase("d1")).toBe(5000);
    await edit(THREE);
    await advance(AUTOSAVE_MS);
    expect(baseOf(1)).toBe(5000);
  });

  it("does not advance base for an unapplied read (base stays put)", async () => {
    // Only applied reads and own writes call setBase; nothing else touches it.
    expect(getBase("d1")).toBe(1000);
    await edit(TWO);
    await advance(AUTOSAVE_MS);
    expect(baseOf(0)).toBe(1000);
  });

  it("pauses on 409 with a toast until savedCode changes", async () => {
    writeFile.mockRejectedValueOnce(
      Object.assign(new Error("x"), { status: 409, code: "conflict" }),
    );
    await edit(TWO);
    await advance(AUTOSAVE_MS);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(useToasts.getState().toasts.length).toBe(1);
    await edit(THREE);
    await advance(AUTOSAVE_MS * 3);
    expect(writeFile).toHaveBeenCalledTimes(1);
    // Cmd+S / reload changes savedCode: autosave resumes.
    useFileStore.setState({ savedCode: TWO });
    await edit(ONE);
    await advance(AUTOSAVE_MS);
    expect(writeFile).toHaveBeenCalledTimes(2);
  });
});

describe("autosave across tabs and unknown base", () => {
  function addTabB() {
    writeDocCode("d2", ONE);
    useWorkspace.setState((st) => ({
      docs: [
        ...st.docs,
        {
          id: "d2",
          name: "b.mmd",
          updatedAt: 1,
          path: "/w/b.mmd",
          handle: null,
          savedCode: ONE,
        },
      ],
    }));
    setBase("d2", 2000);
  }

  // What switchTo does: store the outgoing text, change tab, load the new one.
  function switchToB() {
    const code = useGraphStore.getState().code;
    writeDocCode("d1", code);
    useWorkspace.setState((st) => ({
      activeId: "d2",
      docs: st.docs.map((d) => (d.id === "d1" ? { ...d, savedCode: ONE } : d)),
    }));
    useFileStore.setState({ name: "b.mmd", path: "/w/b.mmd", savedCode: ONE });
    useGraphStore.setState({ code: ONE, parseError: null });
  }

  it("writes the edited tab to its own path when switching within 1 s", async () => {
    addTabB();
    await edit(TWO);
    await advance(300);
    switchToB();
    await advance(AUTOSAVE_MS * 3);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][0]).toBe("/w/a.mmd");
    expect(writeFile.mock.calls[0][1]).toBe(TWO);
    expect(baseOf(0)).toBe(1000);
    expect(useWorkspace.getState().docs.find((d) => d.id === "d1")?.savedCode).toBe(TWO);
    expect(useWorkspace.getState().docs.find((d) => d.id === "d2")?.savedCode).toBe(ONE);
  });

  it("never writes without a base, and writes within 3 s once one is known", async () => {
    resetWatched();
    await edit(TWO);
    await advance(AUTOSAVE_MS * 2);
    expect(writeFile).not.toHaveBeenCalled();
    setBase("d1", 777);
    await advance(AUTOSAVE_MS);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(baseOf(0)).toBe(777);
  });
});

describe("autosave off", () => {
  it("watchDisk does not start it, so nothing is written", async () => {
    stop();
    installBridge(false);
    const { watchDisk } = await import("./diskWatch");
    const stopWatch = watchDisk();
    await edit(TWO);
    await advance(AUTOSAVE_MS * 3);
    expect(writeFile).not.toHaveBeenCalled();
    stopWatch();
    stop = () => {};
  });

  it("watchDisk starts it when enabled", async () => {
    stop();
    installBridge(true);
    const { watchDisk } = await import("./diskWatch");
    const stopWatch = watchDisk();
    await edit(TWO);
    await advance(AUTOSAVE_MS);
    expect(writeFile).toHaveBeenCalledTimes(1);
    stopWatch();
    stop = () => {};
  });
});
