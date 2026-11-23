import { describe, expect, it } from "vitest";
import { placeNodes, withStoredLooks } from "./graph";
import { parseDiagram } from "./model/diagram";
import { render } from "./render/fromCode";
import { readPositions } from "./model/positions";
import { absoluteBoxes, type Box } from "./boxes";
import type { AnyNode } from "./model/types";

/**
 * A document's comments put back onto a fresh parse: the same everywhere the
 * document is drawn, or the canvas, the import preview and the renderer each
 * draw a different picture of one file.
 */

const BENT = `flowchart LR
  a["A"] --> b["B"]
%% graph:positions {"a":{"x":0,"y":0},"b":{"x":400,"y":200}}
%% graph:waypoints {"a>b":[[250,20],[250,220]]}
%% graph:edges {"a>b":{"route":"curved"}}
`;

describe("what a document says about its own drawing", () => {
  it("puts each connection's corners and style back on", async () => {
    const parsed = await parseDiagram(BENT);
    const { edges } = withStoredLooks(BENT, parsed.nodes, parsed.edges);
    expect(edges[0].data?.points).toEqual([
      { x: 250, y: 20 },
      { x: 250, y: 220 },
    ]);
    expect(edges[0].data?.style?.route).toBe("curved");
  });

  it("leaves a document with nothing stored as it was parsed", async () => {
    const plain = 'flowchart LR\n  a["A"] --> b["B"]\n';
    const parsed = await parseDiagram(plain);
    const out = withStoredLooks(plain, parsed.nodes, parsed.edges);
    expect(out.edges).toBe(parsed.edges);
    expect(out.nodes).toBe(parsed.nodes);
  });

  it("is drawn by the renderer through the corners, as on the canvas", async () => {
    // archyne-render drew the connection afresh, ignoring where it was bent.
    const { svg } = await render(BENT);
    const d = svg.match(/<path class="e" d="([^"]+)"/)![1];
    expect(d).toContain("250,");
  });
});

/** Place a document the way the editor does when it carries a positions line. */
async function place(code: string): Promise<AnyNode[]> {
  const parsed = await parseDiagram(code);
  return placeNodes(parsed.nodes, readPositions(code) ?? {}, parsed.kind);
}

const inside = (b: Box, g: Box) =>
  b.x >= g.x && b.y >= g.y && b.x + b.w <= g.x + g.w && b.y + b.h <= g.y + g.h;

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("placeNodes: a subgraph child with no saved position", () => {
  // The shape a tool writes when it adds a phase to a subgraph that the user
  // has already arranged: every node has a position except the new one.
  const saved = {
    impl: { x: 12, y: 1500, w: 372, h: 184 },
    before: { x: 118, y: 1376 },
    P1: { x: 43, y: 40 },
    P2: { x: 16, y: 114 },
    P3: { x: 196, y: 114 },
    after: { x: 118, y: 1764 },
  };
  const doc = (extra: string, positions: object = saved) => `flowchart TB
  before["Before"]
  after["After"]
  subgraph impl ["Implementation"]
    P1["P1 Core changes"]
    P2["P2 API"]
    P3["P3 UI"]
${extra}  end
  before --> impl
  P1 --> P2
  P1 --> P3
  impl --> after

%% graph:positions ${JSON.stringify(positions)}
`;

  it("goes inside its subgraph, clear of its siblings", async () => {
    const nodes = await place(doc(`    P4["P4 Docs"]\n`));
    const boxes = absoluteBoxes(nodes);
    const group = boxes.get("impl")!;
    const p4 = boxes.get("P4")!;
    expect(inside(p4, group)).toBe(true);
    for (const id of ["P1", "P2", "P3"]) expect(overlaps(p4, boxes.get(id)!)).toBe(false);
  });

  it("does not move a saved node that the growth does not reach", async () => {
    // `after` sits just below the subgraph and is pushed down by its growth;
    // see "a growing subgraph pushes aside" below.
    const nodes = await place(doc(`    P4["P4 Docs"]\n`));
    for (const [id, p] of Object.entries(saved)) {
      if (id === "after") continue;
      const n = nodes.find((x) => x.id === id)!;
      expect(n.position, id).toEqual({ x: p.x, y: p.y });
    }
  });

  it("grows the subgraph when there is no free space inside it", async () => {
    const nodes = await place(
      doc(`    P4["P4 Docs"]\n    P5["P5 Tests"]\n    P6["P6 Release"]\n`),
    );
    const boxes = absoluteBoxes(nodes);
    const group = boxes.get("impl")!;
    expect(group.w * group.h).toBeGreaterThan(372 * 184);
    // Grown from where it was: the corner stays put.
    expect({ x: group.x, y: group.y }).toEqual({ x: 12, y: 1500 });
    const ids = ["P1", "P2", "P3", "P4", "P5", "P6"];
    for (const id of ids) expect(inside(boxes.get(id)!, group), id).toBe(true);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        expect(overlaps(boxes.get(ids[i])!, boxes.get(ids[j])!), `${ids[i]}/${ids[j]}`).toBe(
          false,
        );
  });

  it("grows the outer subgraph too when a nested one grows", async () => {
    const code = `flowchart TB
  subgraph outer ["Outer"]
    subgraph inner ["Inner"]
      a["A"]
      b["B"]
    end
  end

%% graph:positions {"outer":{"x":0,"y":0,"w":260,"h":200},"inner":{"x":16,"y":40,"w":228,"h":140},"a":{"x":16,"y":40}}
`;
    const boxes = absoluteBoxes(await place(code));
    const outer = boxes.get("outer")!;
    const inner = boxes.get("inner")!;
    const b = boxes.get("b")!;
    expect(inside(b, inner)).toBe(true);
    expect(overlaps(b, boxes.get("a")!)).toBe(false);
    expect(inside(inner, outer)).toBe(true);
  });
});

describe("a growing subgraph pushes aside the saved nodes it would cover", () => {
  const shift = (nodes: AnyNode[], id: string, from: { x: number; y: number }) => {
    const n = nodes.find((x) => x.id === id)!;
    return { dx: n.position.x - from.x, dy: n.position.y - from.y };
  };
  const grownBy = (nodes: AnyNode[], id: string, w: number, h: number) => {
    const b = absoluteBoxes(nodes).get(id)!;
    return { dw: b.w - w, dh: b.h - h };
  };
  const allPairsClear = (nodes: AnyNode[], ids: string[]) => {
    const boxes = absoluteBoxes(nodes);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        expect(overlaps(boxes.get(ids[i])!, boxes.get(ids[j])!), `${ids[i]}/${ids[j]}`).toBe(
          false,
        );
  };

  it("moves the saved nodes just below it out of the way (the dupin case)", async () => {
    // dupin adds its runbook phases inside `impl`; `verify` and `prs` are
    // saved just below it and ended up under WP-B and WP-C.
    const code = `flowchart TB
  gate_plan{{"Approve the plan"}}
  verify["Verify the work"]
  prs["Open the pull requests"]
  manual_tests["Guide the manual tests"]
  subgraph impl ["Implementation"]
    P1["P1 Core changes"]
    P2["P2 API"]
    P3["P3 UI"]
    P4["P4 Docs"]
    WP-A["WP-A Helper del contratto"]
    WP-B["WP-B API"]
    WP-C["WP-C Interfaccia"]
    WP-D["WP-D Documentazione"]
  end
  gate_plan --> impl
  impl --> verify
  impl --> prs
  verify --> manual_tests
  prs --> manual_tests

%% graph:positions {"impl":{"x":12,"y":1500,"w":372,"h":184},"gate_plan":{"x":118,"y":1376},"P1":{"x":43,"y":40},"P2":{"x":16,"y":114},"P3":{"x":196,"y":114},"verify":{"x":-42,"y":1764},"prs":{"x":240,"y":1764},"manual_tests":{"x":118,"y":2002}}
`;
    const nodes = await place(code);
    const { dh } = grownBy(nodes, "impl", 372, 184);
    expect(dh).toBeGreaterThan(0);
    // Pushed down by exactly the growth, not sideways.
    expect(shift(nodes, "verify", { x: -42, y: 1764 })).toEqual({ dx: 0, dy: dh });
    expect(shift(nodes, "prs", { x: 240, y: 1764 })).toEqual({ dx: 0, dy: dh });
    // Above the subgraph: untouched.
    expect(shift(nodes, "gate_plan", { x: 118, y: 1376 })).toEqual({ dx: 0, dy: 0 });
    const boxes = absoluteBoxes(nodes);
    const impl = boxes.get("impl")!;
    for (const id of ["verify", "prs", "manual_tests"])
      expect(overlaps(boxes.get(id)!, impl), id).toBe(false);
    allPairsClear(nodes, [
      "P1",
      "P2",
      "P3",
      "P4",
      "WP-A",
      "WP-B",
      "WP-C",
      "WP-D",
      "verify",
      "prs",
      "manual_tests",
    ]);
  });

  const chain = (extra: string, positions: object) => `flowchart TB
  a["A"]
  b["B"]
  c["C"]
  side["Beside"]
  subgraph g ["Group"]
    k1["K1"]
${extra}  end
  g --> a
  a --> b
  b --> c

%% graph:positions ${JSON.stringify(positions)}
`;
  const base = {
    g: { x: 0, y: 0, w: 200, h: 120 },
    k1: { x: 16, y: 40 },
    a: { x: 20, y: 200 },
    b: { x: 20, y: 320 },
    c: { x: 20, y: 440 },
    side: { x: 400, y: 20 },
  };
  const more = `    k2["K2"]\n    k3["K3"]\n    k4["K4"]\n`;

  it("moves a chain of saved nodes below it as a block, keeping its spacing", async () => {
    const nodes = await place(chain(more, base));
    const { dh } = grownBy(nodes, "g", 200, 120);
    expect(dh).toBeGreaterThan(0);
    for (const id of ["a", "b", "c"] as const)
      expect(shift(nodes, id, base[id]), id).toEqual({ dx: 0, dy: dh });
    allPairsClear(nodes, ["g", "a", "b", "c", "side"]);
  });

  it("leaves a node beside it alone when the growth does not reach it", async () => {
    const nodes = await place(chain(more, base));
    expect(shift(nodes, "side", base.side)).toEqual({ dx: 0, dy: 0 });
  });

  it("moves nothing when no subgraph grows", async () => {
    const nodes = await place(chain("", { ...base, k1: undefined }));
    for (const id of ["g", "a", "b", "c", "side"] as const)
      expect(shift(nodes, id, base[id]), id).toEqual({ dx: 0, dy: 0 });
  });

  it("pushes right what a wider subgraph would cover", async () => {
    // One row of room: a second node is cheaper beside K1 (the group grows
    // wider) than under it (taller). R1 sits just right of the group, R2
    // further on in the same row; the group's own row is clear of anything.
    const code = `flowchart LR
  r1["R1"]
  r2["R2"]
  subgraph g ["Group"]
    k1["K1"]
    k2["K2"]
  end

%% graph:positions {"g":{"x":0,"y":0,"w":300,"h":110},"k1":{"x":16,"y":40},"r1":{"x":320,"y":20},"r2":{"x":520,"y":20}}
`;
    const nodes = await place(code);
    const { dw, dh } = grownBy(nodes, "g", 300, 110);
    expect(dh).toBe(0);
    expect(dw).toBeGreaterThan(0);
    expect(shift(nodes, "r1", { x: 320, y: 20 })).toEqual({ dx: dw, dy: 0 });
    expect(shift(nodes, "r2", { x: 520, y: 20 })).toEqual({ dx: dw, dy: 0 });
    allPairsClear(nodes, ["g", "r1", "r2"]);
  });

  it("keeps nested subgraphs correct: the inner one pushes inside the outer, the outer outside", async () => {
    const code = `flowchart TB
  below["Below"]
  subgraph outer ["Outer"]
    subgraph inner ["Inner"]
      a1["A1"]
      a2["A2"]
      a3["A3"]
    end
    under["Under inner"]
  end

%% graph:positions {"outer":{"x":0,"y":0,"w":300,"h":300},"inner":{"x":16,"y":40,"w":260,"h":120},"a1":{"x":16,"y":40},"under":{"x":40,"y":190},"below":{"x":40,"y":330}}
`;
    const nodes = await place(code);
    const boxes = absoluteBoxes(nodes);
    const outer = boxes.get("outer")!;
    const inner = boxes.get("inner")!;
    expect(inside(inner, outer)).toBe(true);
    expect(inside(boxes.get("under")!, outer)).toBe(true);
    for (const id of ["a1", "a2", "a3"]) expect(inside(boxes.get(id)!, inner), id).toBe(true);
    expect(overlaps(boxes.get("under")!, inner)).toBe(false);
    expect(overlaps(boxes.get("below")!, outer)).toBe(false);
    // The node below the outer subgraph keeps its gap to it.
    expect(boxes.get("below")!.y - (outer.y + outer.h)).toBe(330 - 300);
  });
});
