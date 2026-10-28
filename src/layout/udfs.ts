/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Ported to TypeScript from triskel (https://github.com/triskellib/triskel).
 */

/**
 * An *unordered* depth-first search: it follows edges in both directions.
 *
 * That is the point, and it is why this is not the ordinary DFS. Cycle
 * equivalence is a property of the *undirected* graph, so the spanning tree it
 * needs has to be built over undirected adjacency — a directed DFS would
 * classify the same edge differently depending on which way it happened to
 * point.
 */

import { INVALID, type EdgeId, type Graph, type NodeId, attribute } from './graph.js';

export const enum EdgeType {
  None,
  Tree,
  Back,
}

export class Udfs {
  /** Nodes in visit order; the index is the DFS number. */
  readonly order: NodeId[] = [];
  readonly dfsNum: number[];
  readonly types: EdgeType[];
  /** Tree parents. A node reached from several keeps all, as the C++ does. */
  readonly parentsOf: NodeId[][];

  constructor(private readonly g: Graph) {
    this.dfsNum = attribute(g.nodeCount, 0);
    this.types = attribute(g.edges.length, EdgeType.None);
    this.parentsOf = Array.from({ length: g.nodeCount }, () => [] as NodeId[]);
    this.visit(g.root);
  }

  /** Iterative, because a CFG is deep and a browser stack is not. */
  private visit(start: NodeId): void {
    type Frame = { node: NodeId; edges: EdgeId[]; index: number };
    const stack: Frame[] = [];

    const enter = (node: NodeId) => {
      this.order.push(node);
      this.dfsNum[node] = this.order.length - 1;
      stack.push({ node, edges: this.g.incident(node), index: 0 });
    };
    enter(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.index >= frame.edges.length) {
        stack.pop();
        continue;
      }
      const edge = frame.edges[frame.index]!;
      frame.index += 1;
      const child = this.g.other(edge, frame.node);

      if (!this.visited(child)) {
        this.types[edge] = EdgeType.Tree;
        this.parentsOf[child]!.push(frame.node);
        enter(child);
        continue;
      }
      if (this.types[edge] === EdgeType.None) this.types[edge] = EdgeType.Back;
    }
  }

  private visited(node: NodeId): boolean {
    return this.dfsNum[node] !== 0 || node === this.g.root;
  }

  isTree(edge: EdgeId): boolean {
    return this.types[edge] === EdgeType.Tree;
  }

  isBackedge(edge: EdgeId): boolean {
    return this.types[edge] === EdgeType.Back;
  }

  setBackedge(edge: EdgeId): void {
    this.types[edge] = EdgeType.Back;
  }

  parent(node: NodeId): NodeId {
    const found = this.parentsOf[node];
    return found && found.length > 0 ? found[0]! : INVALID;
  }

  /** Whether `a` was reached after `b` — the C++ `succeed`. */
  succeed(a: NodeId, b: NodeId): boolean {
    return this.dfsNum[a]! > this.dfsNum[b]!;
  }

  /** Tree children of a node. */
  childrenOf(node: NodeId): NodeId[] {
    const out: NodeId[] = [];
    for (let id = 0; id < this.parentsOf.length; id += 1) {
      if (this.parentsOf[id]!.includes(node)) out.push(id);
    }
    return out;
  }
}
