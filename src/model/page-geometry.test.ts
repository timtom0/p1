/**
 * Page geometry for documents whose pages are not all the same size.
 *
 * ## Why the arithmetic needs its own tests at all
 *
 * With one document-wide size, a page's top offset was `index × (height + gap)` — a multiplication, and
 * a multiplication is hard to get wrong. Per-page sizes replace it with a **running sum**, which is
 * where the interesting mistakes live: an off-by-one in the gap, a page whose own height is not its
 * predecessor's, and a gap that is counted once too often.
 *
 * Each test below is paired with a uniform case carrying the same numbers, because the property that
 * matters is that the mixed case *reduces to* the old one — not that it produces a plausible-looking
 * answer of its own.
 *
 * ## The uniform reductions are the regression net
 *
 * A sum and a product agree when every term is equal. So if `heights = [h, h, h]`, the running sum must
 * produce exactly `index × (h + gap)`. That identity is asserted directly rather than left implicit,
 * because it is what guarantees a mixed-size change did not alter the behaviour of every uniform
 * document that already existed.
 */

import { describe, expect, it } from 'vitest';

import { documentStackExtent, pageExtents, pageIndexAt, pageOffsetY, pageStackExtent } from './page';
import { createDocument, createPage } from './factory';
import type { PageSize } from './types';

const A4: PageSize = { width: 210, height: 297, unit: 'mm', orientation: 'portrait' };
const A5: PageSize = { width: 148, height: 210, unit: 'mm', orientation: 'portrait' };

const GAP = 32;

/** A5 in document px — the same conversion the renderer and viewport use. */
const A5_PX = { width: (148 * 96) / 25.4, height: (210 * 96) / 25.4 };

describe('page offsets with uniform pages', () => {
  const h = 1000;
  const heights = [h, h, h, h];

  it('reduces to the old multiplication', () => {
    for (let index = 0; index < heights.length; index++) {
      expect(pageOffsetY(index, heights, GAP)).toBe(index * (h + GAP));
    }
  });

  it('is zero for the first page', () => {
    expect(pageOffsetY(0, heights, GAP)).toBe(0);
  });

  it('clamps an out-of-range index rather than placing a page past the end', () => {
    // A selection can still name a page deleted two edits ago. Clamping keeps the result on the last
    // page, which is wrong-looking; returning NaN would break every consumer downstream.
    expect(pageOffsetY(99, heights, GAP)).toBe(pageOffsetY(heights.length - 1, heights, GAP));
    expect(pageOffsetY(-5, heights, GAP)).toBe(0);
  });

  it('is zero for an empty stack', () => {
    expect(pageOffsetY(0, [], GAP)).toBe(0);
  });
});

describe('page offsets with mixed pages', () => {
  // Two A4 pages around one A5, which is the arrangement that catches a gap counted twice.
  const heights = [1000, A5_PX.height, 1000];

  it('sums the heights before it, plus one gap each', () => {
    expect(pageOffsetY(0, heights, GAP)).toBe(0);
    expect(pageOffsetY(1, heights, GAP)).toBe(1000 + GAP);
    // The A5 page's own height is what page 2 sits below -- not the A4 height above it.
    expect(pageOffsetY(2, heights, GAP)).toBe(1000 + GAP + A5_PX.height + GAP);
  });

  it('counts each gap exactly once', () => {
    // The error a hand-rolled loop makes: forgetting the trailing gap on the last page summed.
    const total = pageStackExtent(heights, heights, GAP);
    expect(total.height).toBe(1000 + A5_PX.height + 1000 + 2 * GAP);
  });

  it('places a later page where the *actual* heights put it, not the first page size', () => {
    // A shorter page in the middle pulls everything after it **up**. That direction is worth stating,
    // because an implementation that multiplied by the first page's height would push it down instead,
    // and the resulting stack would still look plausible.
    expect(pageOffsetY(2, heights, GAP)).toBeLessThan(2 * (1000 + GAP));

    // And the converse: a taller page in the middle pushes the rest down past the uniform stride.
    const tall = [1000, 1600, 1000];
    expect(pageOffsetY(2, tall, GAP)).toBeGreaterThan(2 * (1000 + GAP));
  });
});

describe('pageIndexAt', () => {
  const uniform = [1000, 1000, 1000];

  it('finds a page by its offset in a uniform stack', () => {
    expect(pageIndexAt(0, uniform, GAP)).toBe(0);
    expect(pageIndexAt(500, uniform, GAP)).toBe(0);
    expect(pageIndexAt(1000 + GAP + 10, uniform, GAP)).toBe(1);
  });

  it('returns null inside the gap between pages', () => {
    // A click in the space between two sheets is not "the nearer page", and callers already treat null
    // as a refusal. Returning the nearer index would make a gap click select an object.
    expect(pageIndexAt(1000 + 5, uniform, GAP)).toBeNull();
  });

  it('returns null past the end and below the start', () => {
    expect(pageIndexAt(99999, uniform, GAP)).toBeNull();
    expect(pageIndexAt(-1, uniform, GAP)).toBeNull();
  });

  it('agrees with pageOffsetY for every page in a mixed stack', () => {
    const heights = [1000, A5_PX.height, 1000];
    for (let index = 0; index < heights.length; index++) {
      const top = pageOffsetY(index, heights, GAP);
      expect(pageIndexAt(top, heights, GAP)).toBe(index);
      // One pixel inside the bottom edge is still that page.
      expect(pageIndexAt(top + heights[index]! - 1, heights, GAP)).toBe(index);
    }
  });

  it('finds a short page that a uniform division would have skipped over', () => {
    // The failure mode the walk exists to prevent: an A5 page between two A4s occupies 794px where the
    // A4 stride is 1032, so `floor(y / stride)` would put y=900 on page 1 when it is still page 0.
    const heights = [1000, A5_PX.height, 1000];
    expect(pageIndexAt(900, heights, GAP)).toBe(0);
  });

  it('is null for an empty stack', () => {
    expect(pageIndexAt(0, [], GAP)).toBeNull();
  });
});

describe('the stack extent', () => {
  it('has n-1 gaps, so one page is exactly its own box', () => {
    expect(pageStackExtent([1000], [600], GAP)).toEqual({ width: 600, height: 1000 });
  });

  it('is as wide as the widest page, not the first', () => {
    // The stack is a column. Taking the first page's width would clip a wide page among narrow ones.
    expect(pageStackExtent([1000, 1000], [600, 900], GAP)).toEqual({ width: 900, height: 2032 });
  });

  it('is zero for an empty stack', () => {
    expect(pageStackExtent([], [], GAP)).toEqual({ width: 0, height: 0 });
  });

  it('matches the document form', () => {
    const doc = createDocument({
      pages: [createPage({ size: A4 }), createPage({ size: A5 }), createPage({ size: A4 })],
    });
    const extents = pageExtents(doc.pages);
    expect(documentStackExtent(doc, GAP)).toEqual(
      pageStackExtent(
        extents.map((e) => e.height),
        extents.map((e) => e.width),
        GAP,
      ),
    );
  });
});

describe('pageExtents', () => {
  it('converts each page independently', () => {
    const doc = createDocument({ pages: [createPage({ size: A4 }), createPage({ size: A5 })] });
    const [first, second] = pageExtents(doc.pages);
    expect(first?.height).toBeGreaterThan(second!.height);
    expect(first?.width).toBeGreaterThan(second!.width);
  });

  it('resolves orientation by swapping, from one place', () => {
    const landscape = createPage({ size: { ...A4, orientation: 'landscape' } });
    const [portraitExtent, landscapeExtent] = pageExtents([createPage({ size: A4 }), landscape]);
    expect(landscapeExtent!.width).toBeCloseTo(portraitExtent!.height, 6);
    expect(landscapeExtent!.height).toBeCloseTo(portraitExtent!.width, 6);
  });
});