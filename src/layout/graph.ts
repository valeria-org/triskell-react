/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Ported to TypeScript from triskel (https://github.com/triskellib/triskel),
 * the implementation of "Towards better CFG layouts". The original is C++ and
 * MPL-2.0; this port is a Modification of it and carries the same licence.
 */

/**
 * The graph the layout works on.
 *
 * Triskel's C++ uses a transactional `GraphEditor` with push/pop so temporary
 * edits — flipped back edges, dummy nodes, the synthetic exit — can be undone.
 * A layout here is computed once over a throwaway copy, so the transaction is
 * unnecessary: nothing outside sees the mutations, and results are read back
 * by the caller's own ids.
 *
 * Nodes and edges are dense integer ids into parallel arrays, as in the
 * original. Attributes are plain arrays indexed by id, which is what
 * `NodeAttribute`/`EdgeAttribute` are.
 */

export type NodeId = number;
export type EdgeId = number;

export const INVALID = -1;

export interface Point {
  x: number;
  y: number;
}

export class Graph {
  /** `edges[e] = [from, to]`. A removed edge has `from === INVALID`. */
  readonly edges: [NodeId, NodeId][] = [];
  /** Edge ids leaving each node. */
  readonly out: EdgeId[][] = [];
  /** Edge ids entering each node. */
  readonly in: EdgeId[][] = [];
  /** Nodes still present. A removed node is absent from this set. */
  readonly live: boolean[] = [];
  root: NodeId = 0;

  makeNode(): NodeId {
    const id = this.out.length;
    this.out.push([]);
    this.in.push([]);
    this.live.push(true);
    return id;
  }

  makeEdge(from: NodeId, to: NodeId): EdgeId {
    const id = this.edges.length;
    this.edges.push([from, to]);
    this.out[from]!.push(id);
    this.in[to]!.push(id);
    return id;
  }

  removeEdge(edge: EdgeId): void {
    const [from, to] = this.edges[edge]!;
    if (from === INVALID) return;
    this.out[from] = this.out[from]!.filter((id) => id !== edge);
    this.in[to] = this.in[to]!.filter((id) => id !== edge);
    this.edges[edge] = [INVALID, INVALID];
  }

  /** Move an edge's endpoints, keeping its identity — the C++ `edit_edge`. */
  editEdge(edge: EdgeId, from: NodeId, to: NodeId): void {
    const [oldFrom, oldTo] = this.edges[edge]!;
    if (oldFrom !== INVALID) {
      this.out[oldFrom] = this.out[oldFrom]!.filter((id) => id !== edge);
      this.in[oldTo] = this.in[oldTo]!.filter((id) => id !== edge);
    }
    this.edges[edge] = [from, to];
    this.out[from]!.push(edge);
    this.in[to]!.push(edge);
  }

  removeNode(node: NodeId): void {
    for (const edge of [...this.out[node]!, ...this.in[node]!]) this.removeEdge(edge);
    this.live[node] = false;
  }

  get nodeCount(): number {
    return this.out.length;
  }

  /** Every live node id. */
  nodes(): NodeId[] {
    const out: NodeId[] = [];
    for (let id = 0; id < this.live.length; id += 1) if (this.live[id]) out.push(id);
    return out;
  }

  /** Every live edge id. */
  edgeIds(): EdgeId[] {
    const out: EdgeId[] = [];
    for (let id = 0; id < this.edges.length; id += 1) {
      if (this.edges[id]![0] !== INVALID) out.push(id);
    }
    return out;
  }

  from(edge: EdgeId): NodeId {
    return this.edges[edge]![0];
  }

  to(edge: EdgeId): NodeId {
    return this.edges[edge]![1];
  }

  /** The endpoint that is not `node` — the C++ `Edge::other`. */
  other(edge: EdgeId, node: NodeId): NodeId {
    const [from, to] = this.edges[edge]!;
    return from === node ? to : from;
  }

  /** Every edge touching a node, in either direction. */
  incident(node: NodeId): EdgeId[] {
    return [...this.out[node]!, ...this.in[node]!];
  }

  children(node: NodeId): NodeId[] {
    return this.out[node]!.map((edge) => this.to(edge));
  }

  parents(node: NodeId): NodeId[] {
    return this.in[node]!.map((edge) => this.from(edge));
  }
}

/** A dense attribute over ids, defaulted. `NodeAttribute` / `EdgeAttribute`. */
export function attribute<T>(size: number, value: T): T[] {
  return new Array<T>(size).fill(value);
}
