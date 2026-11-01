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
import { patchDoc, readDocCode, useWorkspace } from "./workspace";
import { getBase, markWritten, setBase } from "./diskWatch";
import { toast } from "./toast";

export const AUTOSAVE_MS = 1000;

function isConflict(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  return !!e && (e.status === 409 || e.code === "conflict");
}

/** How soon to look again while a document's base is still unknown. */
export const BASE_RETRY_MS = 500;

export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Writes run one at a time, in the order they were asked for. */
  let queue: Promise<void> = Promise.resolve();
  /** Documents edited since their last write. */
  const dirty = new Set<string>();
  /** docId -> last parse verdict seen while that document was on screen. */
  const parseErrors = new Map<string, string | null>();
  /** docId -> savedCode at the moment of the conflict. */
  const paused = new Map<string, string | null>();
  /** savedCode values we set ourselves, so Cmd+S detection ignores them. */
  let ownSaved: string | null = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  /** Write one document if it needs it. Returns true to try again later. */
  async function writeDoc(id: string): Promise<boolean> {
    if (!dirty.has(id)) return false;
    const { docs, activeId } = useWorkspace.getState();
    const doc = docs.find((d) => d.id === id);
    const bridge = desktopBridge();
    if (!doc || !bridge) {
      dirty.delete(id);
      return false;
    }
    const active = id === activeId;
    const file = useFileStore.getState();
    const path = active ? file.path : doc.path;
    if (!path) {
      dirty.delete(id); // scratch document
      return false;
    }
    const code = active ? useGraphStore.getState().code : readDocCode(id);
    const parseError = active
      ? useGraphStore.getState().parseError
      : (parseErrors.get(id) ?? null);
    const savedCode = active ? file.savedCode : doc.savedCode;
    if (code === null || parseError !== null || code === savedCode) {
      dirty.delete(id); // never write what Mermaid cannot read, or what is already saved
      return false;
    }
    if (paused.has(id)) {
      if (paused.get(id) === savedCode) {
        dirty.delete(id);
        return false;
      }
      paused.delete(id);
    }
    const base = getBase(id);
    // An unconditional write could overwrite a change made on disk: wait for
    // diskWatch to record what it last read.
    if (base === undefined) return true;

    try {
      const res = await bridge.writeFile(path, code, { base });
      dirty.delete(id);
      if (id === useWorkspace.getState().activeId) {
        ownSaved = code;
        useFileStore.setState({ savedCode: code });
      }
      patchDoc(id, { savedCode: code });
      if (res && typeof res === "object") markWritten(id, res.mtimeMs);
    } catch (err) {
      dirty.delete(id);
      if (isConflict(err)) {
        paused.set(id, savedCode);
        toast("watch.conflict", "error", { name: doc.name });
      }
      // Anything else: the next edit tries again.
    }
    return false;
  }

  function flushIds(ids: string[]): Promise<void> {
    queue = queue.then(async () => {
      let retry = false;
      for (const id of ids) if (await writeDoc(id)) retry = true;
      if (retry) {
        clear();
        timer = setTimeout(() => void flushAll(), BASE_RETRY_MS);
      }
    });
    return queue;
  }

  function flushAll(): Promise<void> {
    clear();
    return flushIds([...dirty]);
  }

  function schedule() {
    clear();
    timer = setTimeout(() => void flushAll(), AUTOSAVE_MS);
  }

  const unsubCode = useGraphStore.subscribe((s, prev) => {
    const { activeId } = useWorkspace.getState();
    if (activeId && s.parseError !== prev.parseError) parseErrors.set(activeId, s.parseError);
    if (s.code === prev.code) return;
    if (activeId) {
      parseErrors.set(activeId, s.parseError);
      dirty.add(activeId);
    }
    schedule();
  });

  // Switching tabs: the previous document's text has just been stored by the
  // switch, so write it now rather than let the timer find another document.
  const unsubActive = useWorkspace.subscribe((s, prev) => {
    if (s.activeId === prev.activeId || !prev.activeId) return;
    if (dirty.has(prev.activeId)) void flushIds([prev.activeId]);
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
    if (document.visibilityState === "hidden") void flushAll();
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    clear();
    unsubCode();
    unsubActive();
    unsubSaved();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
