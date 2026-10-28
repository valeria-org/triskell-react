/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Ported to TypeScript from triskel (https://github.com/triskellib/triskel),
 * the implementation of "Towards better CFG layouts" — MPL-2.0. This port is a
 * Modification of that work and stays under the same licence.
 */

/**
 * Lay out a control-flow graph, triskel's way.
 *
 * The whole point, and the difference from a plain layered layout: the graph
 * is first split into single-entry single-exit regions, each region is laid
 * out **on its own**, and the result is placed into its parent as one box. A
 * loop body, or the two arms of a branch, therefore get a rectangle of their
 * own and keep their shape however tangled the rest of the function is — and
 * the nesting you see is the nesting in the code.
 *
 * Read {@link ./sese} for the decomposition and {@link ./sugiyama} for what
 * each region gets.
 */

import { Graph, type EdgeId, type NodeId, type Point } from './graph.js';
import { Sese, type Region } from './sese.js';
import { X_GUTTER, Y_GUTTER, sugiyama } from './sugiyama.js';

export type { Point } from './graph.js';

/** A block to place. */
export interface InputNode {
  /** The caller's own id, returned unchanged. */
  id: number;
  width: number;
  height: number;
}

export interface InputEdge {
  id: number;
  from: number;
  to: number;
  /**
   * Where the edge leaves its source, among the source's other edges leaving
   * its bottom: lower is further left. Ties keep the input order. For a
   * conditional branch, give the false side the lower number.
   */
  port?: number;
}

export interface LaidOutNode {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutEdge {
  id: number;
  points: Point[];
}

export interface TriskelLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
  /** How many SESE regions the decomposition found, root included. */
  regions: number;
}

/**
 * Lay out a graph.
 *
 * `entry` is the block control starts at; it anchors the decomposition, and a
 * graph whose entry is unreachable from itself is not a control-flow graph.
 */
export function layout(
  nodes: InputNode[],
  edges: InputEdge[],
  entry: number,
): TriskelLayout {
  if (nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0, regions: 0 };
  }

  // Map the caller's ids onto dense ones.
  const index = new Map<number, NodeId>();
  const g = new Graph();
  const widths: number[] = [];
  const heights: number[] = [];
  for (const node of nodes) {
    const id = g.makeNode();
    index.set(node.id, id);
    widths[id] = node.width;
    heights[id] = node.height;
  }
  g.root = index.get(entry) ?? 0;

  const edgeIndex = new Map<EdgeId, number>();
  const ports: number[] = [];
  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    // An edge to a block outside the set is not drawable, and inventing a
    // target for it would put a line on the picture nothing supports.
    if (from === undefined || to === undefined) continue;
    const id = g.makeEdge(from, to);
    edgeIndex.set(id, edge.id);
    ports[id] = edge.port ?? 0;
  }
  // Each block's edges in port order, ties in input order: their slots.
  const slots: number[] = [];
  for (const node of g.nodes()) {
    [...g.out[node]!]
      .sort((a, b) => ports[a]! - ports[b]! || a - b)
      .forEach((edge, slot) => (slots[edge] = slot));
  }

  const original = { nodes: g.nodeCount, edges: g.edges.length };

  // --- decompose -----------------------------------------------------------
  const sese = new Sese(g);
  sese.removeSmallRegions();

  // --- lay each region out, innermost first --------------------------------
  //
  // A child region is laid out before its parent so the parent knows how big
  // the box it must place is. This is the recursion the whole design is for.
  const xs: number[] = new Array(g.nodeCount).fill(0);
  const ys: number[] = new Array(g.nodeCount).fill(0);
  const waypoints = new Map<EdgeId, Point[]>();
  const placed = new Map<Region, { width: number; height: number }>();

  const ordered = [...sese.regions].sort((a, b) => b.depth - a.depth);

  for (const region of ordered) {
    // The region's own blocks, plus one box per child region.
    const members = region.nodes.filter((node) => node < original.nodes);
    if (members.length === 0 && region.children.length === 0) {
      placed.set(region, { width: 0, height: 0 });
      continue;
    }

    const sub = new Graph();
    const local = new Map<NodeId, NodeId>();
    const subWidths: number[] = [];
    const subHeights: number[] = [];

    const add = (node: NodeId, width: number, height: number): NodeId => {
      const id = sub.makeNode();
      local.set(node, id);
      subWidths[id] = width;
      subHeights[id] = height;
      return id;
    };

    for (const node of members) add(node, widths[node] ?? 0, heights[node] ?? 0);

    // Each child region becomes one node, sized by its own layout.
    const childOf = new Map<NodeId, Region>();
    for (const child of region.children) {
      const box = placed.get(child) ?? { width: 0, height: 0 };
      // Represented by its entry block, which is the node the parent's edges
      // actually point at.
      const anchor = child.entryNode;
      const id = add(anchor, box.width, box.height);
      childOf.set(id, child);
    }

    // Which node in this subgraph an original node maps to: itself if it is a
    // member, otherwise the box of whichever child region contains it.
    const resolve = (node: NodeId): NodeId | undefined => {
      const direct = local.get(node);
      if (direct !== undefined) return direct;
      let owner = sese.nodeRegion[node] ?? null;
      while (owner !== null && owner.parent !== null) {
        if (owner.parent === region) return local.get(owner.entryNode);
        owner = owner.parent;
      }
      return undefined;
    };

    const subEdges = new Map<EdgeId, EdgeId>();
    const subSlots: (number | undefined)[] = [];
    for (const edge of g.edgeIds().filter((id) => id < original.edges)) {
      const from = resolve(g.from(edge));
      const to = resolve(g.to(edge));
      if (from === undefined || to === undefined) continue;
      // `from === to` means the two ends resolve to the same thing. For a
      // block that branches to itself that is the edge's real shape, and the
      // layout draws it as a loop on the side. For two different blocks it
      // means both are inside the same child region, where the edge is drawn
      // on its own — so it belongs to that region and not to this one.
      if (from === to && g.from(edge) !== g.to(edge)) continue;
      const subEdge = sub.makeEdge(from, to);
      subEdges.set(subEdge, edge);
      // A slot orders one block's edges; edges leaving a region's box come
      // from whichever blocks inside it, and have no order between them.
      if (!childOf.has(from)) subSlots[subEdge] = slots[edge];
    }

    // The root region has no entry *edge*, so it has no `entryNode`; its root
    // is the function's own entry — which may itself sit inside a child, in
    // which case the root is that child's box. Getting this wrong puts the
    // entry somewhere other than the top, which is the one thing a reader of
    // a CFG relies on absolutely.
    sub.root =
      (region.parent === null ? resolve(g.root) : local.get(region.entryNode)) ??
      local.get(members[0] ?? 0) ??
      0;

    const result = sugiyama(sub, subWidths, subHeights, subSlots);

    for (const [node, id] of local) {
      const child = childOf.get(id);
      if (child) {
        // Shift the child region's contents to where its box landed.
        translate(child, result.xs[id]!, result.ys[id]!);
      } else {
        xs[node] = result.xs[id]!;
        ys[node] = result.ys[id]!;
      }
    }
    for (const [subEdge, edge] of subEdges) {
      const points = result.waypoints.get(subEdge);
      if (points) waypoints.set(edge, points);
    }

    placed.set(region, { width: result.width, height: result.height });
  }

  /** Move a laid-out region and everything under it. */
  function translate(region: Region, dx: number, dy: number): void {
    const stack: Region[] = [region];
    const seen = new Set<Region>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const node of current.nodes) {
        if (node >= original.nodes) continue;
        xs[node] = (xs[node] ?? 0) + dx;
        ys[node] = (ys[node] ?? 0) + dy;
      }
      for (const [edge, points] of waypoints) {
        if (!ownedBy(edge, current)) continue;
        waypoints.set(
          edge,
          points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
        );
      }
      stack.push(...current.children);
    }
  }

  function ownedBy(edge: EdgeId, region: Region): boolean {
    if (edge >= original.edges) return false;
    return sese.nodeRegion[g.from(edge)] === region;
  }

  // --- normalise -----------------------------------------------------------
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const id = index.get(node.id)!;
    minX = Math.min(minX, xs[id]!);
    minY = Math.min(minY, ys[id]!);
    maxX = Math.max(maxX, xs[id]! + node.width);
    maxY = Math.max(maxY, ys[id]! + node.height);
  }
  for (const points of waypoints.values()) {
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  const outNodes: LaidOutNode[] = nodes.map((node) => {
    const id = index.get(node.id)!;
    return {
      id: node.id,
      x: xs[id]! - minX + X_GUTTER,
      y: ys[id]! - minY + Y_GUTTER,
      width: node.width,
      height: node.height,
    };
  });

  const placedNode = new Map(outNodes.map((node) => [node.id, node]));
  const ends = new Map(edges.map((edge) => [edge.id, edge]));

  /** Is this point on, or just outside, that block? */
  const touches = (point: Point, node: LaidOutNode): boolean =>
    point.x >= node.x - 2 &&
    point.x <= node.x + node.width + 2 &&
    point.y >= node.y - 2 &&
    point.y <= node.y + node.height + 2;

  /**
   * Run the polyline the rest of the way to the block.
   *
   * An edge between two child regions is laid out between their *boxes*, so
   * it stops at a box's edge — which is wherever that region's rectangle
   * happens to end, not where the block is. On a real routine that left a
   * dozen lines hanging in space, several hundred pixels from either block
   * they joined, which reads as an edge arriving from nowhere.
   */
  const reach = (points: Point[], node: LaidOutNode, atStart: boolean): Point[] => {
    const port = atStart
      ? { x: node.x + node.width / 2, y: node.y + node.height }
      : { x: node.x + node.width / 2, y: node.y };
    const near = atStart ? points[0]! : points[points.length - 1]!;
    if (Math.abs(near.x - port.x) < 0.5 && Math.abs(near.y - port.y) < 0.5) return points;

    // One corner, kept orthogonal: leave the block downwards and turn at the
    // far point's level, or arrive at the block downwards having turned at
    // the near point's level.
    const corner = atStart ? { x: port.x, y: near.y } : { x: port.x, y: near.y };
    const added =
      Math.abs(corner.x - near.x) < 0.5 || Math.abs(corner.y - near.y) < 0.5
        ? [port]
        : [port, corner];
    return atStart ? [...added, ...points] : [...points, ...added.reverse()];
  };

  const outEdges: LaidOutEdge[] = [];
  for (const [edge, id] of edgeIndex) {
    const points = waypoints.get(edge);
    if (!points || points.length === 0) continue;
    let moved: Point[] = points.map((point) => ({
      x: point.x - minX + X_GUTTER,
      y: point.y - minY + Y_GUTTER,
    }));
    const ends_ = ends.get(id);
    const source = ends_ ? placedNode.get(ends_.from) : undefined;
    const target = ends_ ? placedNode.get(ends_.to) : undefined;
    if (source && !touches(moved[0]!, source)) moved = reach(moved, source, true);
    if (target && !touches(moved[moved.length - 1]!, target)) moved = reach(moved, target, false);
    outEdges.push({ id, points: moved });
  }
  spreadPorts(outEdges, placedNode, ends);

  return {
    nodes: outNodes,
    edges: outEdges,
    width: maxX - minX + X_GUTTER * 2,
    height: maxY - minY + Y_GUTTER * 2,
    regions: sese.regions.length,
  };
}

/** How far below its block a rerouted edge turns back to its old column. */
const JOG = 10;

/**
 * Give each edge leaving the bottom of one block a start of its own.
 *
 * The region layouts start every out-edge at the block's bottom centre, so
 * the two sides of a branch leave from one point and only part where they
 * turn: which side is which is then a matter of following both. Spread over
 * the bottom, in `port` order, at `(i + ½) / n` of the width (a quarter in
 * from each corner for a branch), they leave apart.
 *
 * Only the start moves. Where the edge ran straight down to a turn, its first
 * leg moves with the start; where the target is straight below and the new
 * column still lands on it, the whole edge moves; otherwise it jogs back to
 * its old column just below the block, so the route through the rest of the
 * drawing — which the layout checked against every block — is kept.
 */
function spreadPorts(
  edges: LaidOutEdge[],
  nodes: Map<number, LaidOutNode>,
  ends: Map<number, InputEdge>,
): void {
  const bySource = new Map<number, LaidOutEdge[]>();
  for (const edge of edges) {
    const input = ends.get(edge.id);
    const source = input && nodes.get(input.from);
    if (!input || !source || input.from === input.to) continue;
    const start = edge.points[0]!;
    // Back edges leave the top and self loops the side: only the bottom is shared.
    if (Math.abs(start.y - (source.y + source.height)) >= 0.5) continue;
    const list = bySource.get(input.from) ?? [];
    list.push(edge);
    bySource.set(input.from, list);
  }

  for (const [from, list] of bySource) {
    if (list.length < 2) continue;
    const source = nodes.get(from)!;
    // `sort` is stable, so equal ports keep the input order.
    list.sort((a, b) => (ends.get(a.id)!.port ?? 0) - (ends.get(b.id)!.port ?? 0));
    list.forEach((edge, index) => {
      const target = nodes.get(ends.get(edge.id)!.to);
      const x = source.x + (source.width * (index + 0.5)) / list.length;
      edge.points = startAt(edge.points, x, target);
    });
  }
}

/** `points` leaving from column `x` instead, kept orthogonal. */
function startAt(points: Point[], x: number, target: LaidOutNode | undefined): Point[] {
  const start = points[0]!;
  const old = start.x;
  if (Math.abs(x - old) < 0.5) return points;
  // The leading vertical run: points[0..k] share the start's column.
  let k = 0;
  while (k + 1 < points.length && Math.abs(points[k + 1]!.x - old) < 0.5) k += 1;
  const last = points.length - 1;

  // Down to a turn right below the block: move the first leg with the start.
  if (k === 1 && k < last) {
    return [{ x, y: start.y }, { x, y: points[1]!.y }, ...points.slice(2)];
  }
  // Straight down onto the target, which the new column still meets.
  if (k === last && target && x > target.x + 4 && x < target.x + target.width - 4) {
    return [{ x, y: start.y }, { x, y: points[last]!.y }];
  }
  // Anything else keeps its route and joins it just below the block.
  const y = start.y + Math.min(JOG, ((points[1]?.y ?? start.y) - start.y) / 2);
  return [{ x, y: start.y }, { x, y }, { x: old, y }, ...points.slice(1)];
}
