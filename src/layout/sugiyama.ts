/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Ported to TypeScript from triskel (https://github.com/triskellib/triskel).
 */

/**
 * The layered layout each SESE region gets.
 *
 * Cycle removal, layer assignment, dummy nodes for long edges, crossing
 * minimisation, then coordinates. Standard Sugiyama; what the original tunes
 * is which parts it bothers with:
 *
 * - **Layering** is only the *feasible tree* phase of network simplex — an
 *   initial longest-path ranking, then tight-tree completion. The C++ says so
 *   outright ("the rest of network simplex. This works already really well
 *   though"), and porting the optimisation it does not run would produce
 *   different layouts from the tool this is meant to match.
 * - **Ordering** is 24 rounds of median + transpose, keeping the best by
 *   crossing count, with crossings counted as inversions via a merge sort.
 * - **Coordinates** are priority-based: a node is drawn toward the average of
 *   its neighbours, but never past a higher-priority node already placed.
 *   Dummy nodes carry the highest priority, which is what keeps a long edge
 *   running straight down instead of zig-zagging around real blocks.
 */

import { type EdgeId, type Graph, type NodeId, type Point, attribute } from './graph.js';

/** The space between nodes on a row. */
export const X_GUTTER = 50;
/** The space between a row and the first edge below it. */
export const Y_GUTTER = 40;
/** How much vertical room one edge claims in the channel between rows. */
export const EDGE_HEIGHT = 30;

export interface SugiyamaResult {
  xs: number[];
  ys: number[];
  /** Polyline per edge, in region coordinates. */
  waypoints: Map<EdgeId, Point[]>;
  width: number;
  height: number;
}

export function sugiyama(
  g: Graph,
  widths: number[],
  heights: number[],
): SugiyamaResult {
  const flipped = attribute(g.edges.length, false);
  const dummies = new Set<NodeId>();
  /** For each original edge, the chain of edges that replaced it. */
  const chains = new Map<EdgeId, EdgeId[]>();
  /** Self loops, with the block they are on: the edge is removed below, and
   *  after that the graph can no longer say where it was. */
  const selfLoops: { edge: EdgeId; node: NodeId }[] = [];

  const size = () => {
    while (widths.length < g.nodeCount) widths.push(0);
    while (heights.length < g.nodeCount) heights.push(0);
    while (flipped.length < g.edges.length) flipped.push(false);
  };

  // --- cycle removal -------------------------------------------------------
  // Back edges are reversed so every edge points down; they are flipped back
  // when the polyline is built, so the drawing still shows the loop.
  {
    const state = attribute(g.nodeCount, 0); // 0 unseen, 1 open, 2 closed
    const walk = (start: NodeId) => {
      const stack: { node: NodeId; index: number }[] = [{ node: start, index: 0 }];
      state[start] = 1;
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        const out = g.out[frame.node]!;
        if (frame.index >= out.length) {
          state[frame.node] = 2;
          stack.pop();
          continue;
        }
        const edge = out[frame.index]!;
        frame.index += 1;
        const child = g.to(edge);
        if (child === frame.node) {
          selfLoops.push({ edge, node: frame.node });
          continue;
        }
        if (state[child] === 1) {
          flipped[edge] = true;
        } else if (state[child] === 0) {
          state[child] = 1;
          stack.push({ node: child, index: 0 });
        }
      }
    };
    walk(g.root);
    for (const node of g.nodes()) if (state[node] === 0) walk(node);
    for (const { edge } of selfLoops) g.removeEdge(edge);
    for (const edge of g.edgeIds()) {
      if (flipped[edge]) g.editEdge(edge, g.to(edge), g.from(edge));
    }
  }

  // --- layer assignment ----------------------------------------------------
  const layers = feasibleTree(g);
  let layerCount = 0;
  for (const node of g.nodes()) layerCount = Math.max(layerCount, layers[node]! + 1);

  // --- dummy nodes for long edges -----------------------------------------
  {
    const long = g.edgeIds().filter((edge) => {
      const a = layers[g.from(edge)]!;
      const b = layers[g.to(edge)]!;
      return Math.abs(a - b) > 1;
    });
    for (const edge of long) {
      const from = g.from(edge);
      const to = g.to(edge);
      // Built in the edge's own direction, from its source to its target.
      //
      // `feasibleTree` inverts the ranking so the entry holds the *highest*
      // layer number, which means a layer index counts *up* the picture while
      // y counts down it. An earlier version of this took the larger layer to
      // be the lower end, built the chain backwards and corrected for it at
      // the end — so every long edge came out drawn from its target to its
      // source. Nothing showed it, because the renderer drew no arrowheads.
      const step = layers[to]! > layers[from]! ? 1 : -1;
      g.removeEdge(edge);
      const chain: EdgeId[] = [];
      let previous = from;
      for (let layer = layers[from]! + step; layer !== layers[to]!; layer += step) {
        const dummy = g.makeNode();
        dummies.add(dummy);
        size();
        widths[dummy] = 0;
        heights[dummy] = 0;
        layers[dummy] = layer;
        chain.push(g.makeEdge(previous, dummy));
        previous = dummy;
      }
      chain.push(g.makeEdge(previous, to));
      chains.set(edge, chain);
      size();
    }
  }
  size();
  while (layers.length < g.nodeCount) layers.push(0);

  // --- rows ----------------------------------------------------------------
  const rows: NodeId[][] = Array.from({ length: layerCount }, () => [] as NodeId[]);
  for (const node of g.nodes()) rows[layers[node]!]?.push(node);

  const orders = order(g, rows, layers);
  for (const row of rows) row.sort((a, b) => orders[a]! - orders[b]!);

  // --- x -------------------------------------------------------------------
  const priorities = attribute(g.nodeCount, 0);
  for (const node of g.nodes()) {
    priorities[node] = dummies.has(node) ? Number.MAX_SAFE_INTEGER : g.incident(node).length;
  }

  let width = 0;
  for (const row of rows) {
    let rowWidth = 0;
    for (const node of row) rowWidth += widths[node]! + X_GUTTER * 2;
    width = Math.max(width, rowWidth);
  }

  const xs = attribute(g.nodeCount, 0);
  for (const row of rows) {
    let x = 0;
    for (const node of row) {
      x += X_GUTTER;
      xs[node] = x;
      x += widths[node]! + X_GUTTER;
    }
  }

  const minX = (row: NodeId[], index: number): number => {
    const priority = priorities[row[index]!]!;
    let w = 0;
    for (let i = index - 1; i >= 0; i -= 1) {
      w += widths[row[i]!]! + X_GUTTER * 2;
      if (priorities[row[i]!]! >= priority) return xs[row[i]!]! + w;
    }
    return w + X_GUTTER;
  };

  const maxX = (row: NodeId[], index: number): number => {
    const priority = priorities[row[index]!]!;
    let w = widths[row[index]!]! + X_GUTTER;
    for (let i = index + 1; i < row.length; i += 1) {
      if (priorities[row[i]!]! > priority) return xs[row[i]!]! - w;
      w += widths[row[i]!]! + X_GUTTER * 2;
    }
    return width - w;
  };

  const averageX = (node: NodeId, layer: number): number => {
    let n = 0;
    let d = 0;
    for (const edge of g.incident(node)) {
      const other = g.other(edge, node);
      if (layers[other] !== layer) continue;
      n += xs[other]! + widths[other]! / 2 - widths[node]! / 2;
      d += 1;
    }
    return d === 0 ? -1 : n / d;
  };

  const pass = (layer: number, towards: number) => {
    const row = rows[layer];
    if (!row) return;
    const indexes = row.map((_, index) => index);
    indexes.sort((a, b) => priorities[row[b]!]! - priorities[row[a]!]!);
    for (const index of indexes) {
      const node = row[index]!;
      let lo = minX(row, index);
      let hi = maxX(row, index);
      if (Math.abs(hi - lo) < 0.01) hi = lo;
      if (lo > hi) {
        lo = (lo + hi) / 2;
        hi = lo;
      }
      const avg = averageX(node, towards);
      const want = avg >= 0 ? avg : xs[node]!;
      xs[node] = Math.min(Math.max(want, lo), hi);
    }
  };

  for (let round = 0; round < 5; round += 1) {
    for (let layer = 1; layer < layerCount; layer += 1) pass(layer, layer - 1);
    for (let layer = layerCount - 1; layer >= 0; layer -= 1) pass(layer, layer + 1);
  }
  for (let layer = 1; layer < layerCount; layer += 1) pass(layer, layer - 1);

  // --- y -------------------------------------------------------------------
  // The highest layer is on top, as in the original: `normalize_ranks`
  // inverts the ranking so the entry ends up with the largest layer number.
  //
  // Sized after x, because what a gap has to hold is the edges that *turn* in
  // it. An edge whose two ends share a column runs straight down and needs no
  // channel at all, which on a control-flow graph is most of them. Sizing
  // before x meant guessing, and the guess was one channel per edge leaving
  // the row: on a 319-block routine that reserved 48,670px of channel for
  // 33,340px of block, and then drew every edge down the middle of it.
  const ys = attribute(g.nodeCount, 0);
  /** For an edge that turns, which channel of its gap it turns in. */
  const channels = new Map<EdgeId, number>();
  const turns = (edge: EdgeId): boolean => {
    const a = xs[g.from(edge)]! + widths[g.from(edge)]! / 2;
    const b = xs[g.to(edge)]! + widths[g.to(edge)]! / 2;
    return Math.abs(a - b) >= 0.5;
  };

  const channelY = new Map<EdgeId, number>();
  let y = 0;
  for (let layer = layerCount - 1; layer >= 0; layer -= 1) {
    let rowHeight = 0;
    let leaving = 0;
    const turning: EdgeId[] = [];
    for (const node of rows[layer]!) {
      rowHeight = Math.max(rowHeight, heights[node]!);
      for (const edge of g.out[node]!) {
        leaving += 1;
        if (turns(edge)) turning.push(edge);
      }
    }
    for (const node of rows[layer]!) ys[node] = y;

    // Each turning edge gets a channel of its own, so two horizontal runs in
    // the same gap cannot land on the same line and read as one.
    turning.forEach((edge, index) => {
      channels.set(edge, index);
      channelY.set(edge, y + rowHeight + Y_GUTTER / 2 + index * EDGE_HEIGHT);
    });

    const gap = leaving === 0 ? 0 : Y_GUTTER + turning.length * EDGE_HEIGHT;
    y += rowHeight + gap;
  }
  const height = y;

  // --- waypoints -----------------------------------------------------------
  const waypoints = new Map<EdgeId, Point[]>();

  const port = (node: NodeId, bottom: boolean): Point => ({
    x: xs[node]! + widths[node]! / 2,
    y: bottom ? ys[node]! + heights[node]! : ys[node]!,
  });

  /** An orthogonal polyline from one port to another, via the channel. */
  const route = (from: NodeId, to: NodeId, channel: number): Point[] => {
    const a = port(from, true);
    const b = port(to, false);
    if (Math.abs(a.x - b.x) < 0.5) return [a, b];
    return [a, { x: a.x, y: channel }, { x: b.x, y: channel }, b];
  };

  for (const edge of g.edgeIds()) {
    const from = g.from(edge);
    const to = g.to(edge);
    // A straight edge never reads the channel; one that turns uses the one
    // reserved for it above.
    const channel = channelY.get(edge) ?? (ys[from]! + heights[from]! + ys[to]!) / 2;
    waypoints.set(edge, route(from, to, channel));
  }

  // Splice each long edge's chain back into one polyline, and undo the
  // reversal so a back edge is drawn in the direction it runs.
  const result = new Map<EdgeId, Point[]>();
  for (const [edge, chain] of chains) {
    const points: Point[] = [];
    for (const part of chain) {
      const piece = waypoints.get(part) ?? [];
      points.push(...(points.length > 0 ? piece.slice(1) : piece));
    }
    // The same rule as a simple edge below: a chain runs source to target, so
    // only a back edge — reversed to make the graph acyclic — is turned round.
    result.set(edge, flipped[edge] ? [...points].reverse() : points);
  }
  for (const edge of g.edgeIds()) {
    if ([...chains.values()].some((chain) => chain.includes(edge))) continue;
    const points = waypoints.get(edge);
    if (!points) continue;
    result.set(edge, flipped[edge] ? [...points].reverse() : points);
  }

  // A self loop leaves the right side and comes back to the top.
  for (const { edge, node: at } of selfLoops) {
    const right = xs[at]! + widths[at]! + X_GUTTER / 2;
    result.set(edge, [
      { x: xs[at]! + widths[at]!, y: ys[at]! + heights[at]! / 2 },
      { x: right, y: ys[at]! + heights[at]! / 2 },
      { x: right, y: ys[at]! - Y_GUTTER / 2 },
      { x: xs[at]! + widths[at]! / 2, y: ys[at]! - Y_GUTTER / 2 },
      { x: xs[at]! + widths[at]! / 2, y: ys[at]! },
    ]);
  }

  return { xs, ys, waypoints: result, width, height };
}

/**
 * Layer assignment: the feasible-tree phase of network simplex.
 *
 * A longest-path initial ranking, then repeatedly pull in the non-tree node
 * joined by the least-slack edge. Ranks are finally inverted so the entry sits
 * at the highest layer, which is what puts it at the top of the drawing.
 */
function feasibleTree(g: Graph): number[] {
  const nodes = g.nodes();
  const ranks = attribute(g.nodeCount, 0);

  // Longest path from the entry, over the acyclic graph.
  let changed = true;
  let guard = 0;
  while (changed && guard < nodes.length + 2) {
    changed = false;
    guard += 1;
    for (const node of nodes) {
      for (const edge of g.out[node]!) {
        const child = g.to(edge);
        if (ranks[child]! < ranks[node]! + 1) {
          ranks[child] = ranks[node]! + 1;
          changed = true;
        }
      }
    }
  }

  // Tighten.
  //
  // Grow the maximal tree of *tight* edges (slack zero) from the entry; when
  // it does not cover the graph, find the least-slack edge joining it to the
  // outside and shift **the whole tree** by that slack, which makes that edge
  // tight without breaking any already-tight one. Repeat.
  //
  // Shifting the whole tree is the part that matters. An earlier version of
  // this port adjusted only the single node being pulled in, which quietly
  // broke the ranking — on a real CFG it put the entry block in the middle of
  // the drawing, which is the one thing a reader of a graph relies on
  // absolutely.
  const inTree = attribute(g.nodeCount, false);

  const growTightTree = (): number => {
    inTree.fill(false);
    inTree[g.root] = true;
    const stack = [g.root];
    let count = 1;
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const edge of g.incident(node)) {
        const other = g.other(edge, node);
        if (inTree[other]) continue;
        const slack = ranks[g.to(edge)]! - ranks[g.from(edge)]! - 1;
        if (slack !== 0) continue;
        inTree[other] = true;
        count += 1;
        stack.push(other);
      }
    }
    return count;
  };

  let rounds = 0;
  while (growTightTree() < nodes.length && rounds < nodes.length + 2) {
    rounds += 1;
    let chosen = -1;
    let minSlack = Number.MAX_SAFE_INTEGER;
    for (const node of nodes) {
      if (inTree[node]) continue;
      for (const edge of g.incident(node)) {
        if (!inTree[g.other(edge, node)]) continue;
        const slack = ranks[g.to(edge)]! - ranks[g.from(edge)]! - 1;
        if (slack < minSlack) {
          minSlack = slack;
          chosen = edge;
        }
      }
    }
    // Nothing joins the tree to the rest: the graph is disconnected, and the
    // components are ranked independently, which is the honest answer.
    if (chosen === -1) break;

    const delta = inTree[g.to(chosen)] ? -minSlack : minSlack;
    for (const node of nodes) if (inTree[node]) ranks[node] = ranks[node]! + delta;
  }

  // Invert, so the highest rank is the entry and is drawn first.
  let max = 0;
  for (const node of nodes) max = Math.max(max, ranks[node]!);
  for (const node of nodes) ranks[node] = max - ranks[node]!;
  return ranks;
}

/**
 * Crossing minimisation: median then transpose, keeping the best of 24 rounds.
 *
 * The 24 is the original's, from the reference it cites. Median sweeps alternate
 * direction by round; transpose then swaps adjacent pairs while that helps.
 */
function order(g: Graph, rows: NodeId[][], layers: number[]): number[] {
  const orders = attribute(g.nodeCount, 0);

  const normalize = () => {
    for (const row of rows) {
      row.sort((a, b) => orders[a]! - orders[b]!);
      row.forEach((node, index) => {
        orders[node] = index;
      });
    }
  };
  normalize();

  let best = [...orders];
  let bestCrossings = Number.MAX_SAFE_INTEGER;

  for (let round = 0; round < 24; round += 1) {
    median(round);
    normalize();
    transpose();
    const crossings = countAll();
    if (crossings < bestCrossings) {
      best = [...orders];
      bestCrossings = crossings;
      if (crossings === 0) break;
    }
  }
  return best;

  function median(round: number): void {
    const down = round % 2 === 0;
    for (const row of rows) {
      for (const node of row) {
        const neighbours = (down ? g.children(node) : g.parents(node))
          .map((other) => orders[other]!)
          .sort((a, b) => a - b);
        if (neighbours.length > 0) {
          orders[node] = neighbours[Math.floor(neighbours.length / 2)]!;
        }
      }
    }
  }

  function neighbourOrders(node: NodeId): { top: number[]; bottom: number[] } {
    const top = g.parents(node).map((other) => orders[other]!).sort((a, b) => a - b);
    const bottom = g.children(node).map((other) => orders[other]!).sort((a, b) => a - b);
    return { top, bottom };
  }

  /** Inversions between two sorted lists — the crossings the pair causes. */
  function inversions(lo: number[], hi: number[]): number {
    let count = 0;
    let i = 0;
    let j = 0;
    while (i < lo.length && j < hi.length) {
      if (lo[i]! > hi[j]!) {
        j += 1;
        count += lo.length - i;
      } else {
        i += 1;
      }
    }
    return count;
  }

  function pairCrossings(a: NodeId, b: NodeId): number {
    const first = neighbourOrders(a);
    const second = neighbourOrders(b);
    return inversions(first.top, second.top) + inversions(first.bottom, second.bottom);
  }

  function transpose(): void {
    let improved = true;
    let guard = 0;
    while (improved && guard < 64) {
      improved = false;
      guard += 1;
      for (const row of rows) {
        for (let i = 0; i + 1 < row.length; i += 1) {
          const v = row[i]!;
          const w = row[i + 1]!;
          const before = pairCrossings(v, w);
          const after = pairCrossings(w, v);
          if (after <= before) {
            if (after < before) improved = true;
            orders[v] = i + 1;
            orders[w] = i;
            row[i] = w;
            row[i + 1] = v;
          }
        }
      }
    }
  }

  function countAll(): number {
    let total = 0;
    for (let layer = 0; layer + 1 < rows.length; layer += 1) {
      const sequence: number[] = [];
      for (const node of rows[layer]!) {
        const below = g
          .incident(node)
          .map((edge) => g.other(edge, node))
          .filter((other) => layers[other] === layer + 1)
          .map((other) => orders[other]!)
          .sort((a, b) => a - b);
        sequence.push(...below);
      }
      total += sortAndCount(sequence);
    }
    return total;
  }

  /** Merge sort, counting inversions: the crossings between two layers. */
  function sortAndCount(values: number[]): number {
    if (values.length < 2) return 0;
    const mid = Math.floor(values.length / 2);
    const lo = values.slice(0, mid);
    const hi = values.slice(mid);
    let count = sortAndCount(lo) + sortAndCount(hi);
    let i = 0;
    let j = 0;
    let k = 0;
    while (i < lo.length && j < hi.length) {
      if (lo[i]! <= hi[j]!) {
        values[k++] = lo[i++]!;
      } else {
        values[k++] = hi[j++]!;
        count += lo.length - i;
      }
    }
    while (i < lo.length) values[k++] = lo[i++]!;
    while (j < hi.length) values[k++] = hi[j++]!;
    return count;
  }
}
