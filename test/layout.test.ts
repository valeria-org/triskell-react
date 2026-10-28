/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The ported layout, against graphs whose right shape is known.
 *
 * These assert *properties* rather than coordinates. Coordinates would pin the
 * port to one machine's floating point and to the exact iteration count the
 * original happens to use; the properties are what someone reading a CFG
 * actually relies on — the entry at the top, an edge that goes down, a block
 * that does not sit on another one.
 */

import { describe, expect, test } from 'vitest';

import { Graph } from '../src/layout/graph.js';
import { Sese } from '../src/layout/sese.js';
import { Udfs } from '../src/layout/udfs.js';
import fixture from './fixtures/routine.json';
import { layout, type InputEdge, type InputNode, type LaidOutNode } from '../src/layout/index.js';

/** `n` blocks of a uniform size. */
function blocks(count: number, width = 120, height = 40): InputNode[] {
  return Array.from({ length: count }, (_, id) => ({ id, width, height }));
}

function edges(pairs: [number, number][]): InputEdge[] {
  return pairs.map(([from, to], id) => ({ id, from, to }));
}

describe('undirected DFS', () => {
  test('follows edges in both directions', () => {
    // 0 -> 1, and 2 -> 1. Node 2 is unreachable *directed* from 0, and must
    // still be found: cycle equivalence is a property of the undirected
    // graph, so the spanning tree has to span it.
    const g = new Graph();
    for (let i = 0; i < 3; i += 1) g.makeNode();
    g.makeEdge(0, 1);
    g.makeEdge(2, 1);

    const udfs = new Udfs(g);
    expect(udfs.order).toHaveLength(3);
    expect(udfs.order).toContain(2);
  });
});

describe('SESE decomposition', () => {
  test('an if/else is a region inside the function', () => {
    //   0
    //  / \
    // 1   2
    //  \ /
    //   3
    const g = new Graph();
    for (let i = 0; i < 4; i += 1) g.makeNode();
    g.makeEdge(0, 1);
    g.makeEdge(0, 2);
    g.makeEdge(1, 3);
    g.makeEdge(2, 3);

    const sese = new Sese(g);
    // At least the root, and the decomposition assigned every original node.
    expect(sese.regions.length).toBeGreaterThanOrEqual(1);
    for (let node = 0; node < 4; node += 1) {
      expect(sese.nodeRegion[node], `node ${node} has no region`).not.toBeNull();
    }
  });

  test('a region of one block is folded into its parent', () => {
    // A box drawn around one box says nothing. The original removes these
    // too, and the count is what the test can see.
    const g = new Graph();
    for (let i = 0; i < 4; i += 1) g.makeNode();
    g.makeEdge(0, 1);
    g.makeEdge(1, 2);
    g.makeEdge(2, 3);

    const sese = new Sese(g);
    const before = sese.regions.length;
    sese.removeSmallRegions();
    expect(sese.regions.length).toBeLessThanOrEqual(before);
    for (const region of sese.regions) {
      if (region.parent !== null && region.children.length === 0) {
        expect(region.nodes.length).not.toBe(1);
      }
    }
  });
});

describe('layout', () => {
  test('a straight line runs straight down', () => {
    const result = layout(blocks(3), edges([[0, 1], [1, 2]]), 0);
    const [a, b, c] = result.nodes;
    expect(a!.y).toBeLessThan(b!.y);
    expect(b!.y).toBeLessThan(c!.y);
    // And it is a column: a chain has no reason to wander sideways.
    expect(Math.abs(a!.x - b!.x)).toBeLessThan(1);
    expect(Math.abs(b!.x - c!.x)).toBeLessThan(1);
  });

  test('a diamond puts its arms side by side, on one row', () => {
    const result = layout(blocks(4), edges([[0, 1], [0, 2], [1, 3], [2, 3]]), 0);
    const at = (id: number) => result.nodes.find((node) => node.id === id)!;

    expect(at(0).y).toBeLessThan(at(1).y);
    expect(at(1).y).toBeCloseTo(at(2).y, 0);
    expect(at(2).y).toBeLessThan(at(3).y);
    // Side by side, not overlapping.
    const left = Math.min(at(1).x, at(2).x);
    const right = Math.max(at(1).x, at(2).x);
    expect(right - left).toBeGreaterThanOrEqual(at(1).width);
  });

  test('no two blocks overlap', () => {
    const result = layout(
      blocks(7),
      edges([[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [4, 5], [4, 6], [5, 6]]),
      0,
    );
    for (const a of result.nodes) {
      for (const b of result.nodes) {
        if (a.id >= b.id) continue;
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart, `blocks ${a.id} and ${b.id} overlap`).toBe(true);
      }
    }
  });

  test('a loop is laid out and its back edge is routed', () => {
    // 0 -> 1 -> 2 -> 1 (the loop), 2 -> 3
    const result = layout(
      blocks(4),
      edges([[0, 1], [1, 2], [2, 1], [2, 3]]),
      0,
    );
    expect(result.nodes).toHaveLength(4);
    const back = result.edges.find((edge) => edge.id === 2);
    expect(back, 'the back edge should be drawn').toBeTruthy();
    expect(back!.points.length).toBeGreaterThanOrEqual(2);
  });

  test('every edge is orthogonal', () => {
    // Each segment runs either horizontally or vertically. A diagonal in a
    // CFG reads as a different kind of line from the ones around it.
    const result = layout(
      blocks(6),
      edges([[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [3, 5]]),
      0,
    );
    for (const edge of result.edges) {
      for (let i = 0; i + 1 < edge.points.length; i += 1) {
        const a = edge.points[i]!;
        const b = edge.points[i + 1]!;
        const orthogonal = Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5;
        expect(orthogonal, `edge ${edge.id} segment ${i} is diagonal`).toBe(true);
      }
    }
  });

  test('the canvas contains everything it laid out', () => {
    const result = layout(blocks(5), edges([[0, 1], [1, 2], [2, 3], [3, 4]]), 0);
    for (const node of result.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(result.width + 0.5);
      expect(node.y + node.height).toBeLessThanOrEqual(result.height + 0.5);
    }
  });

  test('an empty graph lays out to nothing, rather than failing', () => {
    const result = layout([], [], 0);
    expect(result.nodes).toHaveLength(0);
    expect(result.width).toBe(0);
  });

  test('a single block is placed', () => {
    const result = layout(blocks(1), [], 0);
    expect(result.nodes).toHaveLength(1);
    expect(result.width).toBeGreaterThan(0);
  });

  /**
   * An edge naming a block outside the set is dropped, not drawn.
   *
   * Inventing a target would put a line on the picture that nothing supports —
   * and a CFG's whole value is that its lines are claims about control flow.
   */
  test('an edge to a block that is not here is dropped', () => {
    const result = layout(blocks(2), edges([[0, 1], [1, 99]]), 0);
    expect(result.edges.some((edge) => edge.id === 1)).toBe(false);
  });

  test('a graph with a hundred blocks lays out promptly', () => {
    const count = 100;
    const pairs: [number, number][] = [];
    for (let i = 0; i + 1 < count; i += 1) pairs.push([i, i + 1]);
    for (let i = 0; i + 10 < count; i += 10) pairs.push([i, i + 10]);

    const started = Date.now();
    const result = layout(blocks(count), edges(pairs), 0);
    expect(result.nodes).toHaveLength(count);
    // Generous: this is a smoke test against an accidental quadratic, not a
    // benchmark.
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

/**
 * The entry is on top. Always.
 *
 * A regression test for a real defect in this port: the tightening phase
 * adjusted only the node being pulled into the tree, where the original shifts
 * the whole tree. On a nine-block CFG that put the entry block in the middle
 * of the drawing — and the one thing a reader of a control-flow graph relies
 * on absolutely is that the top is where control starts.
 */
test('the entry block is the topmost block', () => {
  // The shape this was found on: a branch whose not-taken arm rejoins the
  // taken one, with a call returning into the middle.
  const result = layout(
    blocks(9),
    edges([
      [0, 1], [0, 2],
      [1, 4], [1, 5],
      [2, 3], [2, 1],
      [4, 3],
      [5, 6], [5, 7],
      [6, 8], [7, 8],
      [8, 4],
    ]),
    0,
  );

  const sorted = [...result.nodes].sort((a, b) => a.y - b.y);
  expect(sorted[0]!.id, 'the entry must be the topmost block').toBe(0);
  // And strictly above everything it reaches.
  const at = (id: number) => result.nodes.find((node) => node.id === id)!;
  expect(at(0).y).toBeLessThan(at(1).y);
  expect(at(0).y).toBeLessThan(at(2).y);
});

/**
 * A real routine, and the three things a drawn edge has to do.
 *
 * Every property below held on every synthetic graph above and failed on this
 * one, which is why the fixture is here: 319 blocks and 468 edges out of
 * `example_win32_directx11.exe`, kept as the graph alone so it stays small.
 * The defects it caught, all three invisible on screen:
 *
 * - both self loops were dropped, because an edge whose ends resolve to the
 *   same thing was taken to be internal to a child region;
 * - all 135 edges long enough to need dummy nodes were drawn from their
 *   target to their source, because the chain was built against the layering
 *   and then reversed to compensate for it;
 * - twelve edges between child regions stopped at the region's box, hundreds
 *   of pixels from either block, which reads as a line arriving from nowhere.
 */
describe('a real routine', () => {
  const routine = fixture as {
    nodes: { id: number; instructions: number; entry: boolean }[];
    edges: { from: number; to: number }[];
  };

  const sized = routine.nodes.map((node) => ({
    id: node.id,
    width: 250,
    height: 30 + Math.min(node.instructions, 3) * 14,
  }));
  const graph = routine.edges.map((edge, id) => ({ id, from: edge.from, to: edge.to }));
  const start = routine.nodes.find((node) => node.entry)?.id ?? 0;
  const result = layout(sized, graph, start);
  const at = (id: number) => result.nodes.find((node) => node.id === id)!;

  /** Is this point on, or within a hair of, that block? */
  const touches = (point: { x: number; y: number }, node: LaidOutNode) =>
    point.x >= node.x - 2 &&
    point.x <= node.x + node.width + 2 &&
    point.y >= node.y - 2 &&
    point.y <= node.y + node.height + 2;

  test('every edge is drawn, including a block that branches to itself', () => {
    expect(result.edges).toHaveLength(graph.length);
    const drawn = new Set(result.edges.map((edge) => edge.id));
    const missing = graph.filter((edge) => !drawn.has(edge.id));
    expect(missing.map((edge) => `${edge.from}->${edge.to}`)).toEqual([]);
    // The two self loops are the ones this was written for.
    expect(graph.filter((edge) => edge.from === edge.to)).not.toHaveLength(0);
  });

  test('an edge starts at its source and ends at its target', () => {
    const backwards: string[] = [];
    for (const edge of result.edges) {
      const { from, to } = graph[edge.id]!;
      if (from === to) continue;
      const first = edge.points[0]!;
      const last = edge.points[edge.points.length - 1]!;
      if (!touches(first, at(from)) || !touches(last, at(to))) {
        // Reversed reads identically without arrowheads, so name it.
        const reversed = touches(first, at(to)) && touches(last, at(from));
        backwards.push(`${from}->${to}${reversed ? ' (drawn backwards)' : ' (touches neither)'}`);
      }
    }
    expect(backwards).toEqual([]);
  });

  test('the canvas is not mostly empty space', () => {
    // A bound rather than an exact size, against one specific mistake: the
    // gap under a row was sized at one channel per edge *leaving* the row,
    // and then every one of those edges was routed down the single midline
    // between the rows. The reserved channels were never used, and on this
    // routine they were 48,670px of the 67,570px canvas. Sizing the gap by
    // the edges that actually turn in it brought that to 46,430px.
    //
    // Both numbers are measured on this fixture; if the block sizes above
    // change, re-measure rather than nudging the bounds.
    const ink = result.nodes.reduce((sum, node) => sum + node.width * node.height, 0);
    expect(ink / (result.width * result.height)).toBeGreaterThan(0.07);
    expect(result.height).toBeLessThan(55_000);
  });
});
