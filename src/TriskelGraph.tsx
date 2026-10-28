/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * A control-flow graph, laid out by the triskel port and drawn as SVG.
 *
 * SVG rather than canvas: a block is a thing you click, select and copy an
 * address out of, and every one of those is free in the DOM and hand-written
 * on a canvas.
 *
 * The view is what makes a large routine workable. A routine with three
 * hundred blocks is a picture some forty screens tall, so the gestures that
 * matter answer *where am I* and *take me there*: the wheel zooms holding the
 * point under the cursor still, a drag pans, the graph opens on its entry, and
 * the imperative handle can fit the whole routine or bring one block into view.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { layout } from './layout/index.js';

/** What an edge *is*, which is what it is coloured by. */
export type EdgeKind = 'flow' | 'taken' | 'not_taken' | 'back';

/** One basic block. */
export interface CfgBlock {
  /** The caller's id; edges name blocks by it, and callbacks return it. */
  id: number;
  /** Drawn on the block's first line, usually its address. */
  label: string;
  /** The block's body, one string per line, drawn in full. */
  lines?: readonly string[];
  /** Overrides the size estimated from the text ({@link blockSize}). */
  width?: number;
  height?: number;
}

export interface CfgEdge {
  from: number;
  to: number;
  /** `flow` when omitted. */
  kind?: EdgeKind;
}

export interface TriskelGraphHandle {
  /** Shrink (or grow) until the whole routine is in the window, centred. */
  fit(): void;
  /** Readable size, centred on block `id`. Unknown ids are ignored. */
  reveal(id: number): void;
}

export interface TriskelGraphProps {
  blocks: readonly CfgBlock[];
  edges: readonly CfgEdge[];
  /** The block control starts at: the top of the drawing, and where it opens. */
  entry: number;
  /** The block drawn as selected, if any. */
  selected?: number;
  /** A click on a block. A drag that panned is not a click. */
  onSelect?: (id: number) => void;
  /** Every zoom change, as a scale factor (1 is layout size). */
  onZoom?: (zoom: number) => void;
  /** Zoom bounds; defaults 0.1 and 2.5. */
  minZoom?: number;
  maxZoom?: number;
  className?: string;
  style?: CSSProperties;
  /** Accessible name of the drawing. */
  label?: string;
}

/** Text geometry the default sizing assumes; `style.css` draws at it. */
export const BLOCK_METRICS = {
  /** Width of one monospace character at the default font. */
  charWidth: 6.8,
  /** Distance between two body lines. */
  lineHeight: 16,
  /** Inner padding left of the text. */
  padX: 8,
  minWidth: 180,
} as const;

/** The size a block gets when the caller does not give one: room for every line. */
export function blockSize(block: CfgBlock): { width: number; height: number } {
  const lines = block.lines ?? [];
  const longest = lines.reduce((most, line) => Math.max(most, line.length), block.label.length);
  return {
    width: block.width ?? Math.max(BLOCK_METRICS.minWidth, longest * BLOCK_METRICS.charWidth + 2 * BLOCK_METRICS.padX + 2),
    height: block.height ?? 20 + lines.length * BLOCK_METRICS.lineHeight + 10,
  };
}

/** The arrowhead, in layout units. */
const HEAD = 7;

const EDGE_CLASS: Record<EdgeKind, string> = {
  flow: 'tg-flow',
  taken: 'tg-taken',
  not_taken: 'tg-not-taken',
  back: 'tg-back',
};

/** Where an edge's last segment points, as a unit vector. */
function heading(points: readonly { x: number; y: number }[]): [number, number] {
  const last = points[points.length - 1]!;
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const dx = last.x - points[index]!.x;
    const dy = last.y - points[index]!.y;
    const length = Math.hypot(dx, dy);
    if (length > 0.5) return [dx / length, dy / length];
  }
  return [0, 1];
}

export const TriskelGraph = forwardRef<TriskelGraphHandle, TriskelGraphProps>(function TriskelGraph(
  { blocks, edges, entry, selected, onSelect, onZoom, minZoom = 0.1, maxZoom = 2.5, className, style, label },
  ref,
) {
  const clipPrefix = useId();
  const [zoom, setZoom] = useState(1);
  const canvas = useRef<HTMLDivElement>(null);
  /** Where to put the scroll once the SVG has been re-sized by a zoom. */
  const held = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const clamp = useCallback((z: number) => Math.min(maxZoom, Math.max(minZoom, z)), [minZoom, maxZoom]);

  // Recomputed only when the graph changes: the layout is the expensive part
  // of drawing one, and doing it per render would make zooming crawl.
  const drawn = useMemo(() => {
    const laid = layout(
      blocks.map((block) => ({ id: block.id, ...blockSize(block) })),
      edges.map((edge, id) => ({ id, from: edge.from, to: edge.to })),
      entry,
    );
    const byId = new Map(blocks.map((block) => [block.id, block]));
    return {
      width: laid.width,
      height: laid.height,
      nodes: laid.nodes.map((node) => ({ ...node, block: byId.get(node.id)! })),
      edges: laid.edges.map((edge) => ({ points: edge.points, kind: edges[edge.id]?.kind ?? 'flow' })),
    };
  }, [blocks, edges, entry]);

  useEffect(() => onZoom?.(zoom), [zoom, onZoom]);

  /**
   * Room around the drawing.
   *
   * A canvas exactly the size of the graph can only be scrolled *within*
   * itself: the first block sits hard against the left edge, and nothing can
   * be brought to the middle of the screen. A margin of most of a viewport on
   * every side makes it a canvas — any part of the routine can be moved
   * anywhere, and a routine smaller than the window is centred in it.
   */
  const [room, setRoom] = useState<{ x: number; y: number } | null>(null);
  // A layout effect, so the first paint already has the measured room and the
  // graph opens centred on its entry rather than a guessed margin away.
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () =>
      setRoom({
        x: Math.max(120, element.clientWidth * 0.45),
        y: Math.max(120, element.clientHeight * 0.45),
      });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const padX = room?.x ?? 400;
  const padY = room?.y ?? 300;
  const width = drawn.width + padX * 2;
  const height = drawn.height + padY * 2;

  /**
   * Zoom, keeping one point of the drawing under one point of the window.
   *
   * Without this every step is followed by hunting for where you were: the
   * SVG grows, the scroll offsets do not, and the drawing slides out from
   * under the cursor by the whole difference.
   */
  const zoomTo = useCallback(
    (next: number, at?: { x: number; y: number }) => {
      const element = canvas.current;
      if (element) {
        const box = element.getBoundingClientRect();
        const px = at ? at.x - box.left : element.clientWidth / 2;
        const py = at ? at.y - box.top : element.clientHeight / 2;
        held.current = { x: (element.scrollLeft + px) / zoom, y: (element.scrollTop + py) / zoom, px, py };
      }
      setZoom(clamp(next));
    },
    [zoom, clamp],
  );

  // After the browser has re-laid the resized SVG, and before it paints: a
  // scroll set in a plain effect is a visible jump.
  useLayoutEffect(() => {
    const element = canvas.current;
    const anchor = held.current;
    held.current = null;
    if (!element || !anchor) return;
    element.scrollLeft = anchor.x * zoom - anchor.px;
    element.scrollTop = anchor.y * zoom - anchor.py;
  }, [zoom]);

  /** Put a point of the drawing in the middle of the window, at zoom `at`. */
  const centreOn = useCallback(
    (x: number, y: number, at: number) => {
      const element = canvas.current;
      if (!element) return;
      element.scrollLeft = (x + padX) * at - element.clientWidth / 2;
      element.scrollTop = (y + padY) * at - element.clientHeight / 2;
    },
    [padX, padY],
  );

  // Open on the entry block rather than on the canvas's corner, which is the
  // empty margin left of the first block. Once per graph, after the room is
  // measured; `zoom` is deliberately not a dependency: this is where the
  // graph opens, not something that re-runs when someone zooms it.
  const opened = useRef<unknown>(null);
  const measured = room !== null;
  useLayoutEffect(() => {
    if (!measured || drawn.nodes.length === 0 || opened.current === drawn) return;
    opened.current = drawn;
    const first = drawn.nodes.find((node) => node.id === entry) ?? drawn.nodes.reduce((top, node) => (node.y < top.y ? node : top));
    centreOn(first.x + first.width / 2, first.y + first.height / 2, zoom);
  }, [drawn, measured]);

  /** Change zoom and then scroll, once the SVG has been resized for it. */
  const zoomAndCentre = useCallback(
    (next: number, x: number, y: number) => {
      held.current = null;
      setZoom(next);
      requestAnimationFrame(() => centreOn(x, y, next));
    },
    [centreOn],
  );

  useImperativeHandle(
    ref,
    () => ({
      fit() {
        const element = canvas.current;
        if (!element || drawn.nodes.length === 0) return;
        // Fitted to the *drawing*, not to the canvas: the room around it is
        // there to pan into, and fitting that too would halve the routine.
        const k = Math.min(element.clientWidth / Math.max(drawn.width, 1), element.clientHeight / Math.max(drawn.height, 1));
        zoomAndCentre(clamp(k), drawn.width / 2, drawn.height / 2);
      },
      reveal(id) {
        const node = drawn.nodes.find((candidate) => candidate.id === id);
        if (node) zoomAndCentre(clamp(1), node.x + node.width / 2, node.y + node.height / 2);
      },
    }),
    [drawn, clamp, zoomAndCentre],
  );

  // Dragging pans. A graph is panned far more often than any block in it is
  // clicked, and reaching for a scrollbar to move sideways is the part that
  // makes a large one tiring.
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // The primary and the wheel button pan. Buttons 3 and 4 are the mouse's
    // back and forward, which the browser turns into history navigation.
    if (event.button !== 0 && event.button !== 1) return;
    // A primary drag that starts *on a block* is a text selection: an
    // instruction is something to copy.
    if (event.button === 0 && (event.target as Element).closest('.tg-block')) return;
    const element = canvas.current;
    if (!element) return;
    // No selection while panning, or a drag sweeps one across every label.
    event.preventDefault();
    drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop, moved: false };
    element.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    const element = canvas.current;
    if (!from || !element) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    // A few pixels of travel is a click with a shaky hand, not a drag.
    if (!from.moved && Math.hypot(dx, dy) < 4) return;
    from.moved = true;
    element.scrollLeft = from.left - dx;
    element.scrollTop = from.top - dy;
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    const element = canvas.current;
    if (!from || !element) return;
    drag.current = null;
    element.releasePointerCapture?.(event.pointerId);
    // A drag that moved is not also a click: the click lands after the
    // release, so it is swallowed here, and only for this gesture.
    if (from.moved) {
      const swallow = (click: MouseEvent) => {
        click.stopPropagation();
        click.preventDefault();
      };
      element.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => element.removeEventListener('click', swallow, { capture: true }), 0);
    }
  };

  // The wheel zooms, at the pointer. Dragging is how the view moves, so the
  // wheel has nothing else to do, and a modifier for the commonest gesture is
  // a modifier held all afternoon. Not a React handler: those are passive, and
  // the page must not scroll as well.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // A trackpad sends many small deltas and a mouse a few large ones, so
      // the step follows the delta rather than being a fixed notch.
      zoomTo(zoom * Math.exp(-event.deltaY / 400), { x: event.clientX, y: event.clientY });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoom, zoomTo]);

  return (
    <div
      className={className ? `tg-canvas ${className}` : 'tg-canvas'}
      style={style}
      ref={canvas}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <svg
        width={width * zoom}
        height={height * zoom}
        viewBox={`${-padX} ${-padY} ${width} ${height}`}
        role="img"
        aria-label={label ?? `Control-flow graph, ${drawn.nodes.length} blocks`}
      >
        {/* Edges first, so a block sits on top of the lines that reach it: an
            edge drawn over a block reads as passing through it. */}
        <g className="tg-edges">
          {drawn.edges.map((edge, index) => {
            const last = edge.points[edge.points.length - 1];
            const [dx, dy] = heading(edge.points);
            return (
              <g key={index} className={`tg-edge ${EDGE_CLASS[edge.kind]}`}>
                <polyline points={edge.points.map((p) => `${p.x},${p.y}`).join(' ')} />
                {last && (
                  // Drawn rather than a marker, in the edge's own class:
                  // direction is a property of the edge.
                  <polygon
                    className="tg-arrow"
                    points={[
                      `${last.x},${last.y}`,
                      `${last.x - dx * HEAD - dy * HEAD * 0.45},${last.y - dy * HEAD + dx * HEAD * 0.45}`,
                      `${last.x - dx * HEAD + dy * HEAD * 0.45},${last.y - dy * HEAD - dx * HEAD * 0.45}`,
                    ].join(' ')}
                  />
                )}
              </g>
            );
          })}
        </g>

        <g className="tg-blocks">
          {drawn.nodes.map((node) => {
            const clip = `${clipPrefix}-${node.id}`;
            return (
              <g
                key={node.id}
                className={node.id === selected ? 'tg-block tg-selected' : 'tg-block'}
                onClick={() => onSelect?.(node.id)}
              >
                <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={2} />
                {/* Clipped to its own block: a caller-sized block narrower
                    than its text would otherwise draw across its neighbour. */}
                <clipPath id={clip}>
                  <rect x={node.x} y={node.y} width={node.width} height={node.height} />
                </clipPath>
                <g clipPath={`url(#${clip})`}>
                  <text className="tg-label" x={node.x + BLOCK_METRICS.padX} y={node.y + 14}>
                    {node.block.label}
                  </text>
                  {(node.block.lines ?? []).map((line, index) => (
                    <text
                      key={index}
                      className="tg-line"
                      x={node.x + BLOCK_METRICS.padX}
                      y={node.y + 30 + index * BLOCK_METRICS.lineHeight}
                    >
                      {line}
                    </text>
                  ))}
                </g>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
});
