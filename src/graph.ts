/**
 * Turning a parse into a graph that can be drawn.
 *
 * Both of these used to live in `store.ts`, and both are pure: given the nodes
 * and edges a parse produced, they say where each node goes and which edges
 * have to be fanned apart. Nothing about either needs a store, a browser or a
 * React Flow instance — but `store.ts` reaches the workspace, which touches
 * `window` while it is evaluating, so a renderer could not call them without
 * booting the editor. Same reason `boxes.ts` exists.
 */
import { isGroup, type AnyNode, type DiagramKind, type FlowEdge } from "./model/types";
import type { PositionMap } from "./model/positions";
import { boxOf } from "./boxes";
import { readNodeStyles } from "./model/nodeStyle";
import { readWaypoints, waypointKeys } from "./model/waypoints";
import { readEdgeStyles } from "./model/edgeStyle";

/**
 * Mark edges that share a node pair (and, for architecture, the same
 * handles) so the canvas can fan them out instead of overlapping them.
 */
export function annotateParallel(kind: DiagramKind, edges: FlowEdge[]): FlowEdge[] {
  if (kind === "sequence") return edges; // messages are stacked by order
  const keyOf = (e: FlowEdge) =>
    `${[e.source, e.target].sort().join("~")}|${e.sourceHandle ?? ""}|${e.targetHandle ?? ""}`;
  const groups = new Map<string, string[]>();
  for (const e of edges) {
    const key = keyOf(e);
    groups.set(key, [...(groups.get(key) ?? []), e.id]);
  }
  return edges.map((e) => {
    // A hand-routed edge keeps its own route: bending one by hand is a more
    // specific instruction than "these two overlap, spread them apart". The
    // lane info goes with the fan-out, so it is dropped rather than left to
    // reappear if the corners are removed later.
    if (e.data?.points?.length) {
      if (e.type === "routed" && !e.data.par) return e;
      const data = { ...(e.data ?? { label: "" }) };
      delete data.par;
      return { ...e, type: "routed" as const, data };
    }
    const g = groups.get(keyOf(e))!;
    if (g.length < 2) {
      // No longer parallel (siblings deleted): strip the stale lane info
      // so the edge snaps back to a plain centered path.
      if (e.type !== "parallel" && !e.data?.par) return e;
      const data = { ...(e.data ?? { label: "" }) };
      delete data.par;
      return { ...e, type: "routed", data };
    }
    return {
      ...e,
      type: "parallel",
      data: {
        ...(e.data ?? { label: "" }),
        // s normalizes the perpendicular offset for opposite-direction
        // edges so they land on distinct lanes, not the same one.
        par: { i: g.indexOf(e.id), n: g.length, s: e.source <= e.target ? 1 : -1 },
      },
    };
  });
}

/** Assign stored/cascade positions to bare nodes. */
export function placeNodes(
  nodes: AnyNode[],
  positions: PositionMap,
  kind: DiagramKind,
): AnyNode[] {
  if (kind === "sequence") {
    // Participants live on a single top row; x order = participant order.
    let col = 0;
    return nodes.map((n) => {
      const p = positions[n.id];
      const x = p?.x ?? col * 220;
      col++;
      return { ...n, position: { x, y: 0 } };
    });
  }
  const placed = Object.values(positions);
  let cascadeX = placed.length > 0 ? Math.max(...placed.map((p) => p.x)) + 260 : 0;
  let cascadeY = 0;
  const ids = new Set(nodes.map((n) => n.id));
  // A child's position is relative to its group, so the cascade (which is in
  // canvas terms) would put it outside the group it belongs to. Children are
  // placed inside their group instead, once every sibling is known. With no
  // saved positions at all, ELK lays the whole drawing out next, so there is
  // nothing to preserve and the search is skipped.
  const insideGroup = (n: AnyNode) =>
    placed.length > 0 && !!n.parentId && ids.has(n.parentId) && !positions[n.id];
  const out = nodes.map((n) => {
    const p = positions[n.id];
    if (insideGroup(n)) return n;
    if (!p) {
      const pos = { x: cascadeX, y: cascadeY };
      cascadeY += 110;
      if (cascadeY > 660) {
        cascadeY = 0;
        cascadeX += 260;
      }
      return { ...n, position: pos };
    }
    return {
      ...n,
      position: { x: p.x, y: p.y },
      // React Flow reads the explicit dimensions off both places, and the
      // node views read `width`/`height` to draw themselves at the right
      // size, so both are set rather than one being derived later.
      ...(p.w !== undefined && p.h !== undefined
        ? { style: { ...n.style, width: p.w, height: p.h }, width: p.w, height: p.h }
        : {}),
    };
  });
  return placeInsideGroups(out, insideGroup);
}

/** Room a group keeps around its contents: ELK's group padding (top holds the title). */
const PAD = { top: 40, left: 16, bottom: 16, right: 16 };
/** Clearance between a placed node and its siblings. */
const GAP = 24;

/**
 * Put each child that has no saved position inside its group, in free space.
 *
 * Candidate spots are the group's top-left corner and the spots just right of
 * and just below each sibling, tried in reading order (top to bottom, then
 * left to right). The first one that overlaps no sibling and fits inside the
 * group wins. If none fits, the free spot that grows the group least wins, and
 * the group grows to hold it.
 *
 * Deepest children first, so a nested group that has to grow is at its final
 * size by the time it is placed in its own parent.
 *
 * A group that grew then pushes what it would cover out of its way — see
 * `pushAside` — and its own parent grows to hold the result, innermost first.
 * Nothing moves unless a group grew.
 */
function placeInsideGroups(nodes: AnyNode[], pending: (n: AnyNode) => boolean): AnyNode[] {
  const todo = new Set(nodes.filter(pending).map((n) => n.id));
  if (todo.size === 0) return nodes;
  const placedHere = new Set(todo);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = (n: AnyNode): number => {
    let d = 0;
    const seen = new Set<string>();
    for (let p = n.parentId; p && !seen.has(p); p = byId.get(p)?.parentId) {
      seen.add(p);
      d++;
    }
    return d;
  };
  const deepestFirst = (a: AnyNode, b: AnyNode) => depth(b) - depth(a);
  const order = nodes.filter((n) => todo.has(n.id)).sort(deepestFirst);
  const groups = nodes.filter(isGroup);
  /** Each group's box as saved, before anything was placed in it. */
  const original = new Map(groups.map((g) => [g.id, boxOf(g)]));

  const grow = (groupId: string, w: number, h: number) => {
    const g = byId.get(groupId)!;
    const b = boxOf(g);
    if (w <= b.w && h <= b.h) return;
    const width = Math.max(w, b.w);
    const height = Math.max(h, b.h);
    byId.set(groupId, {
      ...g,
      style: { ...g.style, width, height },
      width,
      height,
      measured: undefined,
    } as AnyNode);
  };

  for (const n of order) {
    const parentId = n.parentId!;
    const siblings = [...byId.values()]
      .filter((s) => s.parentId === parentId && s.id !== n.id && !todo.has(s.id))
      .map(boxOf);
    const size = boxOf({ ...n, position: { x: 0, y: 0 } } as AnyNode);
    const frame = boxOf(byId.get(parentId)!);
    const xs = [PAD.left, ...siblings.map((s) => s.x + s.w + GAP)];
    const ys = [PAD.top, ...siblings.map((s) => s.y + s.h + GAP)];
    const free = (x: number, y: number) =>
      siblings.every(
        (s) =>
          x + size.w + GAP <= s.x ||
          s.x + s.w + GAP <= x ||
          y + size.h + GAP <= s.y ||
          s.y + s.h + GAP <= y,
      );
    let best: { x: number; y: number; area: number } | null = null;
    for (const y of [...new Set(ys)].sort((a, b) => a - b))
      for (const x of [...new Set(xs)].sort((a, b) => a - b)) {
        if (x < PAD.left || y < PAD.top || !free(x, y)) continue;
        const w = Math.max(frame.w, x + size.w + PAD.right);
        const h = Math.max(frame.h, y + size.h + PAD.bottom);
        const area = w * h;
        if (!best || area < best.area) best = { x, y, area };
      }
    // There is always a free spot: below every sibling, at the left padding.
    const spot = best ?? { x: PAD.left, y: Math.max(PAD.top, ...ys) };
    byId.set(n.id, { ...byId.get(n.id)!, position: { x: spot.x, y: spot.y } } as AnyNode);
    todo.delete(n.id);
    grow(parentId, spot.x + size.w + PAD.right, spot.y + size.h + PAD.bottom);
  }

  // Innermost first: a group that grew pushes its neighbours aside, and its
  // parent then grows to hold the result, which may push at the next level.
  for (const g of [...groups].sort(deepestFirst)) {
    const was = original.get(g.id)!;
    const now = boxOf(byId.get(g.id)!);
    // A group placed here was put in free space at its final size: it
    // covers nothing, so it has nothing to push.
    if (!placedHere.has(g.id) && (now.w > was.w || now.h > was.h)) {
      pushAside(byId, g.id, was, now);
    }
    const parentId = g.parentId;
    if (parentId && byId.has(parentId)) {
      let w = 0;
      let h = 0;
      for (const c of byId.values()) {
        if (c.parentId !== parentId) continue;
        const b = boxOf(c);
        w = Math.max(w, b.x + b.w + PAD.right);
        h = Math.max(h, b.y + b.h + PAD.bottom);
      }
      grow(parentId, w, h);
    }
  }
  return nodes.map((n) => byId.get(n.id)!);
}

type Rect4 = { x: number; y: number; w: number; h: number };

/** Strict overlap: boxes that only touch do not overlap. */
const overlap = (a: Rect4, b: Rect4) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inflate = (r: Rect4, by: number): Rect4 => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + 2 * by,
  h: r.h + 2 * by,
});

/**
 * Move the siblings that a grown group would now cover out of its way: down
 * by the growth in height, then right by the growth in width.
 *
 * What moves is what the new part of the group reaches (within the usual
 * clearance) and did not already overlap — plus everything below (or right
 * of) the first of those, so the part of the drawing past the group moves as
 * a block and keeps its own spacing. Anything a moved item would then land
 * on moves with it, and everything past that too, so no new overlap appears.
 * A sibling beside the group that the growth does not reach stays put.
 *
 * Only the drawing changes: the positions line is rewritten when the user
 * edits the diagram, as for every other render-time placement.
 */
function pushAside(byId: Map<string, AnyNode>, groupId: string, was: Rect4, now: Rect4) {
  const scope = byId.get(groupId)!.parentId;
  const siblings = [...byId.values()].filter((s) => s.parentId === scope && s.id !== groupId);

  const pass = (axis: "x" | "y", delta: number, before: Rect4) => {
    if (delta <= 0) return;
    const box = new Map(siblings.map((s) => [s.id, boxOf(byId.get(s.id)!)]));
    const reach = inflate(now, GAP);
    const moved = new Set(
      siblings
        .filter((s) => overlap(box.get(s.id)!, reach) && !overlap(box.get(s.id)!, before))
        .map((s) => s.id),
    );
    if (moved.size === 0) return;
    const shifted = (r: Rect4): Rect4 => ({ ...r, [axis]: r[axis] + delta });
    for (let changed = true; changed;) {
      changed = false;
      const from = Math.min(...[...moved].map((id) => box.get(id)![axis]));
      for (const s of siblings) {
        if (moved.has(s.id)) continue;
        const b = box.get(s.id)!;
        const landedOn = [...moved].some((id) => overlap(shifted(box.get(id)!), b));
        if (b[axis] >= from || landedOn) {
          moved.add(s.id);
          changed = true;
        }
      }
    }
    for (const id of moved) {
      const n = byId.get(id)!;
      byId.set(id, {
        ...n,
        position: { ...n.position, [axis]: n.position[axis] + delta },
      } as AnyNode);
    }
  };

  // Down first, across the full new width; then right, over the old width
  // and the full new height — what the first pass moved is already clear.
  pass("y", now.h - was.h, { x: now.x, y: now.y, w: now.w, h: was.h });
  pass("x", now.w - was.w, { x: now.x, y: now.y, w: was.w, h: now.h });
}

/**
 * What a document's own comments say about its drawing, put back onto a
 * fresh parse: how each node is drawn, and each connection's corners and
 * style.
 *
 * They live in comments keyed by id and by endpoints, because a re-parse
 * replaces the node and edge objects and nothing on them survives. The
 * editor matched them back on; the import preview and `archyne-render` did
 * not, so the same file drew its connections without their corners — routed
 * from scratch, differently from the canvas it was about to be opened on.
 * One function now, for all three.
 */
export function withStoredLooks(
  code: string,
  nodes: AnyNode[],
  edges: FlowEdge[],
): { nodes: AnyNode[]; edges: FlowEdge[] } {
  const looks = readNodeStyles(code);
  const styled = looks
    ? nodes.map((n) =>
        looks[n.id] ? ({ ...n, data: { ...n.data, style: looks[n.id] } } as AnyNode) : n,
      )
    : nodes;

  const stored = readWaypoints(code);
  const styles = readEdgeStyles(code);
  if (!stored && !styles) return { nodes: styled, edges };
  const keys = waypointKeys(edges);
  const routed = edges.map((e) => {
    const key = keys.get(e.id)!;
    const points = stored?.[key];
    const style = styles?.[key];
    if (!points && !style) return e;
    return {
      ...e,
      data: {
        ...(e.data ?? { label: "" }),
        ...(points ? { points } : {}),
        ...(style ? { style } : {}),
      },
    };
  });
  return { nodes: styled, edges: routed };
}
