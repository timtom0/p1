import { describe, expect, it } from 'vitest';
import type { Document, Page } from './types';
import { apply, isNoop } from './commands';
import { createDocument, createRectNode, createShapeNode, createTransform } from './factory';

/**
 * `setProps` no-op detection.
 *
 * §4.2's rule is that `apply` returns the *same reference* when a command changes nothing,
 * because `History` reads reference identity as "nothing happened". `setProps` did not
 * honour it: it spread the payload over the node unconditionally, so every commit
 * produced a new object.
 *
 * M5 made this load-bearing rather than latent. Fill, stroke, stroke width and opacity all
 * commit through `setProps`, and each of those fields re-commits whenever it loses focus —
 * so an inspector that opened and closed on an unchanged colour put an entry on the undo
 * stack, and the user's next Ctrl+Z appeared to do nothing.
 */
const page = (objects: Page['objects']): Page => ({
  id: 'p1',
  name: '1',
  background: { type: 'solid', color: '#ffffff' },
  objects,
});

function docWith(node: ReturnType<typeof createRectNode>): Document {
  return createDocument({ pages: [page([node])] });
}

const filled = () =>
  createRectNode({
    id: 'a',
    transform: createTransform({ x: 10, y: 20, width: 100, height: 50 }),
    fill: { type: 'solid', color: '#4f7cff' },
    stroke: { paint: { type: 'solid', color: '#000000' }, width: 6, align: 'inside' },
  });

describe('setProps is a no-op when it writes what the node already holds', () => {
  it('for a top-level scalar', () => {
    const doc = docWith(filled());
    const command = { type: 'setProps', ids: ['a'], props: { opacity: 1 } } as const;
    // The discriminating assertion: reference identity, not deep equality. `apply` must
    // return the *same document*, because that is what makes `isNoop` true.
    expect(apply(doc, command)).toBe(doc);
    expect(isNoop(doc, command)).toBe(true);
  });

  it('for a nested value the node already holds', () => {
    const doc = docWith(filled());
    // Written as a complete replacement, because `setProps` replaces a top-level key
    // wholesale -- that is how the inspector sends a dotted path (see `propsWithPath`).
    const same = { type: 'solid', color: '#4f7cff' } as const;
    expect(isNoop(doc, { type: 'setProps', ids: ['a'], props: { fill: same } })).toBe(true);
  });

  it('for a stroke sub-value', () => {
    const doc = docWith(filled());
    expect(
      isNoop(doc, {
        type: 'setProps',
        ids: ['a'],
        props: { stroke: { paint: { type: 'solid', color: '#000000' }, width: 6, align: 'inside' } },
      }),
    ).toBe(true);
  });

  it('and still changes the document when the value really is different', () => {
    const doc = docWith(filled());
    const command = {
      type: 'setProps',
      ids: ['a'],
      props: { fill: { type: 'solid', color: '#ff0000' } },
    } as const;
    expect(isNoop(doc, command)).toBe(false);
    expect(apply(doc, command)).not.toBe(doc);
  });

  it('and when only one of several props differs', () => {
    const doc = docWith(filled());
    const command = {
      type: 'setProps',
      ids: ['a'],
      props: {
        // `opacity` is unchanged; `stroke.width` is not. A shallow "all props differ"
        // check would call this a change and a shallow "any prop differs" check is what
        // is implemented -- so this is the case that separates the two.
        opacity: 1,
        stroke: { paint: { type: 'solid', color: '#000000' }, width: 12, align: 'inside' },
      },
    } as const;
    expect(isNoop(doc, command)).toBe(false);
  });
});

describe('clearing a property that is already clear is a no-op', () => {
  it('for an absent key', () => {
    // `createRectNode` fills in a fill only when one is passed, so this rect genuinely
    // has no `fill`. Clearing it therefore changes nothing.
    const doc = docWith(createRectNode({ id: 'a' }));
    expect(isNoop(doc, { type: 'setProps', ids: ['a'], props: { fill: undefined } })).toBe(true);
  });

  it('but clearing a property that *is* set is a change', () => {
    const doc = docWith(filled());
    expect(isNoop(doc, { type: 'setProps', ids: ['a'], props: { fill: undefined } })).toBe(
      false,
    );
  });

  it('for writing undefined over null, and vice versa', () => {
    // The inspector writes `undefined` to clear a property, and the model may already
    // spell "cleared" as `null`. Treating them as the same thing means the *first* clear
    // is recorded and the second is not.
    const node = createRectNode({ id: 'a', opacity: null as unknown as number });
    const doc = docWith(node);
    expect(isNoop(doc, { type: 'setProps', ids: ['a'], props: { opacity: undefined } })).toBe(
      true,
    );
  });
});

describe('no-op detection is per node, not per command', () => {
  it('leaves the objects alone when only some of them already hold the value', () => {
    const a = createRectNode({ id: 'a', opacity: 0.5 });
    const b = createRectNode({ id: 'b', opacity: 1 });
    const doc = createDocument({ pages: [page([a, b])] });

    const command = { type: 'setProps', ids: ['a', 'b'], props: { opacity: 0.5 } } as const;
    // `b` genuinely changes, so the document must. If the check were "are all props the
    // same for all nodes", this would be dropped and half the selection would silently
    // not apply.
    expect(isNoop(doc, command)).toBe(false);
    const next = apply(doc, command);
    expect(next).not.toBe(doc);
  });
});

describe('setProps still replaces a top-level key wholesale', () => {
  it('so a partial nested write is the caller job, not the funnel job', () => {
    // Documenting the contract rather than changing it: the funnel does not merge nested
    // objects, because `unknown`-valued payloads with structural merging would be a second
    // equality implementation. `propsWithPath` in the inspector builds the complete value.
    const doc = docWith(filled());
    const next = apply(doc, {
      type: 'setProps',
      ids: ['a'],
      props: { stroke: { width: 2 } },
    });
    const node = next.pages[0]?.objects[0];
    expect(node?.type === 'shape' ? node.stroke : undefined).toEqual({ width: 2 });
  });

  it('and a dotted key is added literally, not applied as a path', () => {
    const doc = docWith(filled());
    // `apply` spreads the payload, so `'fill.color'` is stored as a literal key and
    // `fill` is untouched. The no-op check reads top-level keys only, so this is
    // reported as a change and really is one. Pinned because the alternative -- reading
    // the nested value -- would silently drop a command that adds a junk key.
    const next = apply(doc, {
      type: 'setProps',
      ids: ['a'],
      props: { 'fill.color': '#ff0000' },
    });
    const node = next.pages[0]?.objects[0];
    expect(node?.type === 'shape' ? node.fill : undefined).toEqual({
      type: 'solid',
      color: '#4f7cff',
    });
    expect('fill.color' in (node ?? {})).toBe(true);
  });
});

describe('setProps applies to shapes of every kind', () => {
  it('including a line, whose geometry has no optional fields', () => {
    // A discriminated union means `{ kind: 'line' }` has no `cornerRadius`, so there is
    // nothing for the no-op check to trip over -- but the command must still apply.
    const line = createShapeNode('line', {
      id: 'line-1',
      transform: createTransform({ width: 100, height: 0 }),
    });
    const doc = createDocument({ pages: [page([line])] });
    const command = {
      type: 'setProps',
      ids: ['line-1'],
      props: { opacity: 0.25 },
    } as const;
    const next = apply(doc, command);
    expect(next.pages[0]?.objects[0]?.opacity).toBe(0.25);
  });
});