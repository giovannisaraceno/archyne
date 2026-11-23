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

  it("does not move any node that has a saved position", async () => {
    const nodes = await place(doc(`    P4["P4 Docs"]\n`));
    for (const [id, p] of Object.entries(saved)) {
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
