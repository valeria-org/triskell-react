/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Ported to TypeScript from triskel (https://github.com/triskellib/triskel).
 */

/**
 * Single-entry single-exit regions, by cycle equivalence.
 *
 * This is triskel's contribution and the reason its graphs read the way they
 * do. Rather than laying out a function as one flat graph, it finds the nested
 * SESE regions — the loops, the if/else arms, the guarded blocks — lays each
 * out on its own, and puts the result back into its parent as a single box.
 * The hierarchy in the picture is then the hierarchy in the code.
 *
 * The decomposition is Johnson, Pearson and Pingali's cycle-equivalence
 * algorithm: two edges are cycle-equivalent when every cycle containing one
 * contains the other, and a pair of cycle-equivalent edges bounds a region.
 * It is computed with bracket lists over an undirected DFS.
 */

import { INVALID, type EdgeId, type Graph, type NodeId, attribute } from './graph.js';
import { Udfs } from './udfs.js';

export interface Region {
  id: number;
  parent: Region | null;
  children: Region[];
  depth: number;
  entryEdge: EdgeId;
  entryNode: NodeId;
  exitEdge: EdgeId;
  exitNode: NodeId;
  nodes: NodeId[];
}

export class Sese {
  readonly regions: Region[] = [];
  root!: Region;
  /** Which region each node belongs to. */
  readonly nodeRegion: (Region | null)[];

  private udfs!: Udfs;
  private his: number[];
  private blists: EdgeId[][];
  private classes: number[];
  private recentSize: number[];
  private recentClass: number[];
  private entryEdge: boolean[];
  private exitEdge: boolean[];
  private cappingBackedges: EdgeId[] = [];
  private edgeClass = 1;

  constructor(private readonly g: Graph) {
    this.nodeRegion = attribute<Region | null>(g.nodeCount, null);
    this.his = attribute(g.nodeCount, Number.MAX_SAFE_INTEGER);
    this.blists = Array.from({ length: g.nodeCount }, () => [] as EdgeId[]);
    this.classes = attribute(g.edges.length + g.nodeCount * 2, 0);
    this.recentSize = attribute(g.edges.length + g.nodeCount * 2, 0);
    this.recentClass = attribute(g.edges.length + g.nodeCount * 2, 0);
    this.entryEdge = attribute(g.edges.length + g.nodeCount * 2, false);
    this.exitEdge = attribute(g.edges.length + g.nodeCount * 2, false);

    this.preprocess();
    this.grow();
    this.udfs = new Udfs(g);
    this.grow();

    this.cycleEquivalence();

    this.determineBoundaries();
    this.buildTree();
  }

  /** Attributes are sized for the graph as it was; edits grow it. */
  private grow(): void {
    const nodes = this.g.nodeCount;
    const edges = this.g.edges.length;
    while (this.his.length < nodes) this.his.push(Number.MAX_SAFE_INTEGER);
    while (this.blists.length < nodes) this.blists.push([]);
    while (this.nodeRegion.length < nodes) this.nodeRegion.push(null);
    for (const list of [this.classes, this.recentSize, this.recentClass]) {
      while (list.length < edges) list.push(0);
    }
    for (const list of [this.entryEdge, this.exitEdge]) {
      while (list.length < edges) list.push(false);
    }
  }

  /**
   * Add a single exit and link it back to the entry.
   *
   * Cycle equivalence is defined on a strongly connected graph. A function has
   * one entry and may have many returns, so the returns are joined to one
   * synthetic exit and that exit is joined back to the entry — which makes
   * every path a cycle and the algorithm applicable.
   */
  private preprocess(): void {
    const exit = this.g.makeNode();
    for (const node of this.g.nodes()) {
      if (node === exit) continue;
      if (this.g.out[node]!.length === 0) this.g.makeEdge(node, exit);
    }
    if (this.g.in[exit]!.length === 0) this.g.removeNode(exit);
    else this.g.makeEdge(exit, this.g.root);
  }

  private newClass(): number {
    this.edgeClass += 1;
    return this.edgeClass;
  }

  private isBackedgeFrom(edge: EdgeId, from: NodeId, to: NodeId): boolean {
    return this.udfs.isBackedge(edge) && this.udfs.succeed(from, to);
  }

  private cycleEquivalence(): void {
    // Reverse DFS order: a node is processed after everything below it.
    for (const node of [...this.udfs.order].reverse()) {
      this.grow();
      const hi0 = this.hi0(node);
      const hi1 = this.hi1(node);
      this.his[node] = Math.min(hi0, hi1);
      const hi2 = this.hi2(node, hi1);

      let blist = this.blists[node]!;
      for (const child of this.udfs.childrenOf(node)) {
        blist = blist.concat(this.blists[child]!);
      }

      // Drop capping back edges that end below this node.
      for (const capping of this.cappingBackedges) {
        const child = this.g.other(capping, node);
        if (this.udfs.succeed(child, node)) {
          blist = blist.filter((id) => id !== capping);
        }
      }

      for (const edge of this.g.incident(node)) {
        const other = this.g.other(edge, node);
        if (this.isBackedgeFrom(edge, other, node)) {
          blist = blist.filter((id) => id !== edge);
          if (this.classes[edge] === 0) this.classes[edge] = this.newClass();
        }
      }
      for (const edge of this.g.incident(node)) {
        const other = this.g.other(edge, node);
        if (this.isBackedgeFrom(edge, node, other)) blist.push(edge);
      }

      this.blists[node] = blist;

      if (hi2 < hi0) this.createCappingBackedge(node, hi2);
      if (node !== this.g.root) this.determineClass(node);
    }
  }

  private hi0(node: NodeId): number {
    let hi = Number.MAX_SAFE_INTEGER;
    for (const edge of this.g.incident(node)) {
      const other = this.g.other(edge, node);
      if (this.isBackedgeFrom(edge, node, other)) {
        hi = Math.min(hi, this.udfs.dfsNum[other]!);
      }
    }
    return hi;
  }

  private hi1(node: NodeId): number {
    let hi = Number.MAX_SAFE_INTEGER;
    for (const edge of this.g.incident(node)) {
      const child = this.g.other(edge, node);
      if (this.udfs.parent(child) === node) hi = Math.min(hi, this.his[child]!);
    }
    return hi;
  }

  /** The second-smallest child `hi`: one child achieving `hi1` is skipped. */
  private hi2(node: NodeId, hi1: number): number {
    let hi = Number.MAX_SAFE_INTEGER;
    let skipped = false;
    for (const edge of this.g.incident(node)) {
      const child = this.g.other(edge, node);
      if (this.udfs.parent(child) !== node) continue;
      const value = this.his[child]!;
      if (!skipped && value === hi1) skipped = true;
      else hi = Math.min(hi, value);
    }
    return hi;
  }

  private createCappingBackedge(node: NodeId, hi2: number): void {
    const target = this.udfs.order[hi2];
    if (target === undefined) return;
    const edge = this.g.makeEdge(node, target);
    this.grow();
    this.udfs.types[edge] = 2; // Back
    this.cappingBackedges.push(edge);
    this.blists[node]!.push(edge);
  }

  private determineClass(node: NodeId): void {
    const tree = this.parentTreeEdge(node);
    if (tree === INVALID) return;
    const blist = this.blists[node]!;
    if (blist.length === 0) return;
    const top = blist[blist.length - 1]!;

    if (this.recentSize[top] !== blist.length) {
      this.recentSize[top] = blist.length;
      this.recentClass[top] = this.newClass();
    }
    this.classes[tree] = this.recentClass[top]!;
    if (this.recentSize[top] === 1) this.classes[top] = this.classes[tree]!;
  }

  private parentTreeEdge(node: NodeId): EdgeId {
    for (const edge of this.g.incident(node)) {
      const other = this.g.other(edge, node);
      if (this.udfs.isTree(edge) && this.udfs.parent(node) === other) return edge;
    }
    return INVALID;
  }

  /**
   * Mark the edges that bound a region.
   *
   * Walking down from the entry, an edge whose class matches one already on
   * the stack closes the region that the earlier edge opened: the two are
   * cycle-equivalent, so everything between them is entered only through the
   * first and left only through the second.
   */
  private determineBoundaries(): void {
    const visited = attribute(this.g.nodeCount, false);
    type Seen = { edge: EdgeId; klass: number };

    const walk = (node: NodeId, stack: Seen[]): void => {
      visited[node] = true;
      for (const edge of this.g.out[node]!) {
        const child = this.g.to(edge);
        const klass = this.classes[edge]!;
        const next = [...stack];

        let depth = 0;
        for (let i = next.length - 1; i >= 0; i -= 1) {
          depth += 1;
          if (next[i]!.klass === klass) {
            this.exitEdge[edge] = true;
            this.entryEdge[next[i]!.edge] = true;
            next.length = next.length - depth;
            break;
          }
        }

        if (!visited[child]) {
          next.push({ edge, klass });
          walk(child, next);
        }
      }
    };
    walk(this.g.root, []);
  }

  /** The program structure tree: regions nested as the code nests. */
  private buildTree(): void {
    const visited = attribute(this.g.nodeCount, false);
    this.root = this.makeRegion(null);

    const walk = (node: NodeId, current: Region): void => {
      visited[node] = true;
      this.nodeRegion[node] = current;
      current.nodes.push(node);

      for (const edge of this.g.out[node]!) {
        const child = this.g.to(edge);
        let next = current;
        const region = this.nodeRegion[node]!;

        if (this.exitEdge[edge]) {
          region.exitEdge = edge;
          region.exitNode = this.g.from(edge);
          next = region.parent ?? region;
        }
        if (this.entryEdge[edge]) {
          const made = this.makeRegion(next);
          made.entryEdge = edge;
          made.entryNode = this.g.to(edge);
          next = made;
        }
        if (!visited[child]) walk(child, next);
      }
    };
    walk(this.g.root, this.root);
  }

  private makeRegion(parent: Region | null): Region {
    const region: Region = {
      id: this.regions.length,
      parent,
      children: [],
      depth: parent ? parent.depth + 1 : 0,
      entryEdge: INVALID,
      entryNode: INVALID,
      exitEdge: INVALID,
      exitNode: INVALID,
      nodes: [],
    };
    parent?.children.push(region);
    this.regions.push(region);
    return region;
  }

  /**
   * Fold a region holding a single node back into its parent.
   *
   * A region of one block is a box drawn around one box. The original does
   * this too, for the same reason: the hierarchy should show structure, not
   * every place the algorithm could have drawn a line.
   */
  removeSmallRegions(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const region of [...this.regions]) {
        if (
          region.parent !== null &&
          region.children.length === 0 &&
          region.nodes.length === 1
        ) {
          const node = region.nodes[0]!;
          region.parent.nodes.push(node);
          this.nodeRegion[node] = region.parent;
          region.parent.children = region.parent.children.filter((r) => r !== region);
          this.regions.splice(this.regions.indexOf(region), 1);
          changed = true;
        }
      }
    }
    this.regions.forEach((region, index) => {
      region.id = index;
    });
  }
}
