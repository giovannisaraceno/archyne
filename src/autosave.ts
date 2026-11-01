/**
 * Workspace autosave: write the active file-backed document back to disk
 * shortly after the last edit, and when the page is hidden.
 *
 * Only runs when the server enabled it (`workspace.autosave`). Each write is
 * conditional on `base`, the mtime of the last read or own write we know of,
 * so an edit made on disk in the meantime is never overwritten: the server
 * answers 409, the user is told, and this document stops autosaving until
 * its saved text changes (reload from disk, or Cmd+S).
 */
import { desktopBridge, useFileStore } from "./files";
import { useGraphStore } from "./store";
import { patchDoc, useWorkspace } from "./workspace";
import { getBase, markWritten, setBase } from "./diskWatch";
import { toast } from "./toast";

export const AUTOSAVE_MS = 1000;

function isConflict(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  return !!e && (e.status === 409 || e.code === "conflict");
}

export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing = false;
  /** docId -> savedCode at the moment of the conflict. */
  const paused = new Map<string, string | null>();
  /** savedCode values we set ourselves, so Cmd+S detection ignores them. */
  let ownSaved: string | null = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  async function flush(): Promise<void> {
    clear();
    if (writing) {
      schedule();
      return;
    }
    const { docs, activeId } = useWorkspace.getState();
    const doc = docs.find((d) => d.id === activeId);
    if (!doc) return;
    const file = useFileStore.getState();
    const path = file.path;
    const bridge = desktopBridge();
    if (!path || !bridge) return; // scratch document, or no bridge
    const graph = useGraphStore.getState();
    const code = graph.code;
    if (graph.parseError !== null) return; // never write what Mermaid cannot read
    if (code === file.savedCode) return;
    if (paused.has(doc.id)) {
      if (paused.get(doc.id) === file.savedCode) return;
      paused.delete(doc.id);
    }

    writing = true;
    try {
      const base = getBase(doc.id);
      const res = await bridge.writeFile(path, code, base === undefined ? undefined : { base });
      ownSaved = code;
      useFileStore.setState({ savedCode: code });
      patchDoc(doc.id, { savedCode: code });
      if (res && typeof res === "object") markWritten(doc.id, res.mtimeMs);
    } catch (err) {
      if (isConflict(err)) {
        paused.set(doc.id, file.savedCode);
        toast("watch.conflict", "error", { name: doc.name });
      }
      // Anything else: the next edit tries again.
    } finally {
      writing = false;
    }
  }

  function schedule() {
    clear();
    timer = setTimeout(() => void flush(), AUTOSAVE_MS);
  }

  const unsubCode = useGraphStore.subscribe((s, prev) => {
    if (s.code !== prev.code) schedule();
  });

  // Cmd+S writes without a base: pick up the new mtime so the next autosave
  // is not mistaken for a conflict with our own save.
  const unsubSaved = useFileStore.subscribe((s, prev) => {
    if (s.savedCode === prev.savedCode) return;
    if (s.savedCode === ownSaved) return;
    const { activeId } = useWorkspace.getState();
    const bridge = desktopBridge();
    if (!activeId || !s.path || !bridge?.statFile) return;
    void bridge
      .statFile(s.path)
      .then((st) => {
        if (st) setBase(activeId, st.mtimeMs);
      })
      .catch(() => {});
  });

  const onVisibility = () => {
    if (document.visibilityState === "hidden") void flush();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    clear();
    unsubCode();
    unsubSaved();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
