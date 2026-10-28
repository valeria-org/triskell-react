# triskell-react

Control-flow-graph layout for the browser, and a React view that draws it.

The layout is a TypeScript port of [**triskel**](https://github.com/triskellib/triskel),
the CFG layout engine that accompanies the paper
[*Towards Better CFG Layouts*](https://hal.science/hal-04996939). Rather than
laying out a function as one flat graph, triskel splits it into
**single-entry single-exit (SESE) regions**: the loops, the arms of a branch,
the guarded blocks. It lays each region out on its own and places the result
into its parent as a single box. The nesting in the picture is then the
nesting in the code, and a tangle in one part of a function cannot distort
another.

## Acknowledgements

This package exists because of triskel. Thank you to
[Jack Royer](https://github.com/Garfield1002) and the
[triskel contributors](https://github.com/triskellib/triskel/graphs/contributors) for the
library, and to Jack Royer, Frédéric Tronel and Yaëlle Vinçont for the
research behind it. The SESE decomposition, the region-by-region layout and
the layered layout each region gets all follow their design and their C++
implementation. If triskel is useful to you, use the original from
[triskellib/triskel](https://github.com/triskellib/triskel) (C++, with Python
bindings as [`pytriskel`](https://pypi.org/project/pytriskel/)) and cite the
paper:

```bibtex
@inproceedings{royer:hal-04996939,
  title     = {{Towards Better CFG Layouts}},
  author    = {Royer, Jack and Tronel, Fr{\'e}d{\'e}ric and Vin{\c c}ont, Ya{\"e}lle},
  booktitle = {{BAR 2025 - Workshop on Binary Analysis Research}},
  address   = {San Diego (CA), United States},
  pages     = {1-17},
  year      = {2025},
  month     = feb,
  doi       = {10.14722/bar.2025.23011},
  url       = {https://hal.science/hal-04996939}
}
```

Bugs in this port are ours, not triskel's. Please report them
[here](https://github.com/valeria-org/triskell-react/issues).

## Install

```sh
npm install git+https://github.com/valeria-org/triskell-react.git
```

React 18 or later is a peer dependency. The layout alone (`triskell-react/layout`)
has no dependencies at all.

## Use

### The React view

```tsx
import { useRef } from 'react';
import { TriskelGraph, type TriskelGraphHandle } from 'triskell-react';
import 'triskell-react/style.css';

const blocks = [
  { id: 0, label: '0x401000', lines: ['test ecx, ecx', 'je 0x401010'] },
  { id: 1, label: '0x401008', lines: ['mov eax, 1', 'jmp 0x401015'] },
  { id: 2, label: '0x401010', lines: ['xor eax, eax'] },
  { id: 3, label: '0x401015', lines: ['ret'] },
];
const edges = [
  { from: 0, to: 2, kind: 'taken' },
  { from: 0, to: 1, kind: 'not_taken' },
  { from: 1, to: 3 },
  { from: 2, to: 3 },
] as const;

export function Function() {
  const graph = useRef<TriskelGraphHandle>(null);
  return (
    <>
      <button onClick={() => graph.current?.fit()}>fit</button>
      <TriskelGraph
        ref={graph}
        blocks={blocks}
        edges={edges}
        entry={0}
        onSelect={(id) => console.log('block', id)}
        style={{ height: 600 }}
      />
    </>
  );
}
```

- **Gestures.** The wheel zooms around the pointer, dragging the background
  pans, and dragging over a block selects its text. A click on a block calls
  `onSelect`; a drag that panned does not.
- **Opening.** The graph opens centred on `entry`.
- **Handle.** `fit()` fits the whole routine in the window; `reveal(id)`
  centres a block at readable size.
- **Sizing.** A block is sized to hold its label and every line
  (`blockSize`, `BLOCK_METRICS`). Pass `width`/`height` on a block to size it
  yourself.
- **Edges.** `kind` is `flow`, `taken`, `not_taken` or `back` and sets the
  edge's class (`tg-flow`, `tg-taken`, `tg-not-taken`, `tg-back`). The layout
  does not classify edges; that is the caller's knowledge.
- **Branches.** The edges leaving a block's bottom leave from separate points:
  `not_taken` (false) on the left, `taken` (true) on the right, a quarter in
  from each corner. The layout prefers to put the false side's target on the
  left too, so the two do not cross under the block unless the graph forces it.
- **Styling.** `style.css` is a default theme driven by custom properties on
  `.tg-canvas` (`--tg-bg`, `--tg-block`, `--tg-accent`, `--tg-taken`, …). The
  canvas scrolls, so give it a height.

### The layout alone

```ts
import { layout } from 'triskell-react/layout';

const result = layout(
  [
    { id: 0, width: 120, height: 40 },
    { id: 1, width: 120, height: 40 },
  ],
  [{ id: 0, from: 0, to: 1 }],
  0, // the entry block
);
// result.nodes: { id, x, y, width, height }[]   (top-left corners)
// result.edges: { id, points: { x, y }[] }[]    (orthogonal polylines, source to target)
// result.width, result.height, result.regions
```

An edge naming a block that is not in the set is dropped rather than drawn.

`port` on an edge orders the edges leaving its source's bottom, lower further
left (ties keep input order). Several such edges leave at (i + ½) / n
of the block's width rather than from its middle, and the ordering phase counts
the crossings their order makes, so their targets tend to follow it. A lone
edge leaves from the middle.

## How the port differs from triskel

Stated because a port that quietly diverges is worse than one that says so.

- **Layering** ports only the feasible-tree phase of network simplex, because
  that is all the original runs. Its own source says "the rest of network
  simplex. This works already really well though".
- **Edge routing** is channel-based and orthogonal. It is not a transcription
  of the original's `waypoint_creation`, which carries index arithmetic for
  cases this port does not reproduce (top and bottom loops, IO waypoints across
  region boundaries). Edges are not point-for-point identical to the C++, and
  a few still contain a diagonal segment (4 of 468 on the test routine).
- **Ports.** Separate start points for a block's out-edges, and the
  crossing count that respects them, are this port's addition.
- **Phantom nodes**, which the original inserts to factor out common edge
  paths, are not ported.
- **The RTree** the original's renderers use for hit-testing is not needed:
  the graph is SVG, so hit-testing is the DOM's.

| File | |
|---|---|
| `src/layout/graph.ts` | the mutable graph the layout works on |
| `src/layout/udfs.ts` | the *undirected* DFS that cycle equivalence needs |
| `src/layout/sese.ts` | cycle equivalence, and the program structure tree |
| `src/layout/sugiyama.ts` | what one region gets: layering, ordering, coordinates |
| `src/layout/index.ts` | the recursive region driver, and the public API |
| `src/TriskelGraph.tsx` | the React view |

## Develop

```sh
npm install
npm run check   # typecheck and tests
npm run build   # dist/
```

The tests assert properties, not coordinates: the entry on top, edges
starting at their source and ending at their target, no overlapping blocks,
every segment orthogonal. `test/fixtures/routine.json` is a real routine's
graph (319 blocks, 468 edges, from the Dear ImGui `example_win32_directx11`
sample), kept because every property held on every synthetic graph and failed
on it.

## Licence

[MPL-2.0](LICENSE), as triskel is. The layout is a Modification of triskel
under the MPL, and every source file carries the MPL notice.
