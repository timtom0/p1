/**
 * Validation: the untrusted-input boundary.
 *
 * A `.p1doc` on disk is untrusted even when this machine wrote it — it may have been
 * hand-edited, truncated, pasted from another tool, or written by a future build. So this
 * suite is mostly a list of things that must be **refused**, and it is deliberately long:
 * a strict parser's value is entirely in which malformed inputs it rejects, and an
 * unlisted case is an unhandled case.
 *
 * ## Every test here is a negative control
 *
 * A test that asserts `parse` throws passes just as happily if `parse` throws for *every*
 * input, which would make the format unusable and the suite green. So each case asserts the
 * **path** in the message, not merely that something was thrown — a parser that refused
 * everything could not produce `pages[1].objects[3].transform.width`. And the
 * "valid documents still load" case is asserted alongside, so a parser that refused too
 * much fails too.
 *
 * ## Repair is deliberately absent
 *
 * §6.2's sketch proposed "a repair path that collects rather than throws on recoverable
 * problems". It is not built, and ADR 0007 §5 gives the reasoning: silently dropping one bad
 * node out of a three-hundred-object document is a data-loss decision the user never made.
 * Refusing tells them exactly which field to fix, which is only useful if the parser says
 * *which*.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/persist/deserialize';
import { validateDocument } from '../../src/model/invariants';
import {
  CURRENT_FORMAT_VERSION,
  DOCUMENT_FORMAT,
  DocumentParseError,
  MINIMUM_FORMAT_VERSION,
} from '../../src/persist/format';
import type { PersistedDocument } from '../../src/persist/format';

// ---------------------------------------------------------------------------
// A valid document to mutate.
//
// Written as a builder so each test changes exactly one thing and the diff is the cause.
// `structuredClone` rather than a literal per test: twenty hand-written documents would be
// twenty opportunities for a test to be testing a typo.
// ---------------------------------------------------------------------------

function validDocument(): Record<string, unknown> {
  return {
    format: DOCUMENT_FORMAT,
    formatVersion: CURRENT_FORMAT_VERSION,
    id: 'doc_1',
    name: 'Valid',
    pageSize: { width: 210, height: 297, unit: 'mm', orientation: 'portrait' },
    assets: {
      asset_1: {
        kind: 'image',
        mime: 'image/png',
        intrinsicWidth: 8,
        intrinsicHeight: 6,
        data: { inline: 'data:image/png;base64,AAA' },
      },
    },
    pages: [
      {
        id: 'page_1',
        name: '1',
        background: { type: 'solid', color: '#ffffff' },
        objects: [
          {
            type: 'shape',
            id: 'node_1',
            name: 'Rect',
            transform: { x: 1, y: 2, width: 3, height: 4, rotation: 0, scaleX: 1, scaleY: 1 },
            visible: true,
            locked: false,
            opacity: 1,
            blendMode: 'normal',
            shape: { kind: 'rect', cornerRadius: 0 },
          },
        ],
      },
    ],
  };
}

/** Replaces one value, addressing it by a slash path. */
function withField(path: string, value: unknown): Record<string, unknown> {
  const root = validDocument();
  const parts = path.split('/');
  let cursor: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (part === undefined) throw new Error('empty path segment');
    cursor = (cursor as Record<string, unknown>)[part] as Record<string, unknown> | unknown[];
  }
  const last = parts[parts.length - 1];
  if (last === undefined) throw new Error('empty path segment');
  (cursor as Record<string, unknown>)[last] = value;
  return root;
}

/** Removes one value, addressing it by a slash path. */
function withoutField(path: string): Record<string, unknown> {
  const root = validDocument();
  const parts = path.split('/');
  let cursor: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (part === undefined) throw new Error('empty path segment');
    cursor = (cursor as Record<string, unknown>)[part] as Record<string, unknown> | unknown[];
  }
  const last = parts[parts.length - 1];
  if (last === undefined) throw new Error('empty path segment');
  if (Array.isArray(cursor)) {
    (cursor as unknown[]).splice(Number(last), 1);
  } else {
    delete (cursor as Record<string, unknown>)[last];
  }
  return root;
}

/** Asserts a refusal, and that the message names the offending path. */
function expectRefusal(input: unknown, pathFragment: string): DocumentParseError {
  let thrown: unknown;
  try {
    parse(input);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'expected a refusal, got a document').toBeInstanceOf(DocumentParseError);
  const error = thrown as DocumentParseError;
  expect(
    error.message,
    `expected the message to name "${pathFragment}"`,
  ).toContain(pathFragment);
  return error;
}

// ---------------------------------------------------------------------------
// The control: the unmutated document loads
// ---------------------------------------------------------------------------

describe('a valid document', () => {
  it('loads', () => {
    // Present in every run of this suite. Without it, "parse throws for everything" would
    // satisfy every refusal test below.
    const doc = parse(validDocument());
    expect(doc.pages[0]?.objects).toHaveLength(1);
    expect(doc.assets['asset_1']?.mime).toBe('image/png');
  });
});

// ---------------------------------------------------------------------------
// The root
// ---------------------------------------------------------------------------

describe('the root', () => {
  it.each([
    ['null', null],
    ['a string', 'p1doc'],
    ['a number', 7],
    ['an array', []],
  ])('refuses %s', (_label, input) => {
    expectRefusal(input, '');
  });

  it('refuses an undeclared top-level field', () => {
    // The load-bearing policy: a key this build does not know is either a version mismatch
    // or a hand-edit, and dropping it would let the document look fine while having lost
    // authored state.
    const root = { ...validDocument(), guides: [] };
    const error = expectRefusal(root, 'guides');
    expect(error.message).toContain('unknown field');
  });

  it('refuses an own `__proto__` key rather than letting it reach the object', () => {
    // Not paranoia. Two things are being distinguished:
    //
    //  - A `{ __proto__: x }` object *literal* sets the prototype, so it has no own key and
    //    `JSON.stringify` drops it. Testing with a literal would prove nothing.
    //  - `JSON.parse` uses `DefineOwnProperty`, so a `__proto__` key in the file really is
    //    an own enumerable property -- which is what an unknown-key check must reject.
    //
    // The check itself is written with `Object.keys`, so it does not walk the prototype
    // chain; asserting the key is really present keeps the test honest about which
    // implementation it is exercising.
    const json = `{"__proto__": {"polluted": true}, ${JSON.stringify(validDocument()).slice(1)}`;
    const input = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(input)).toContain('__proto__');

    expectRefusal(input, '__proto__');

    // And nothing leaked onto `Object.prototype` on the way.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('the format marker', () => {
  it('refuses another format', () => {
    const error = expectRefusal(withField('format', 'sketch'), 'format');
    expect(error.message).toContain('not a P1 document');
  });

  it('refuses a missing marker', () => {
    expectRefusal(withoutField('format'), 'format');
  });
});

describe('the version', () => {
  it('refuses a newer file, naming both versions', () => {
    // Never silently downgraded: a file from a build that knows fields this one does not
    // may mean anything at all here.
    const error = expectRefusal(
      withField('formatVersion', CURRENT_FORMAT_VERSION + 1),
      'formatVersion',
    );
    expect(error.message).toContain('newer version');
    expect(error.message).toContain(String(CURRENT_FORMAT_VERSION + 1));
  });

  it('refuses a file older than the oldest this build reads, naming both versions', () => {
    // A *different* message, because it needs a different action from the user. Collapsing
    // the two directions into one "unsupported version" would leave the user unable to tell
    // "update P1" from "this file is stale".
    //
    // The boundary moved in M12 and that is the interesting part. This used to be
    // `CURRENT_FORMAT_VERSION - 1`, because there was only ever one accepted version and so the
    // nearest older one was necessarily a refusal. Now version 1 is *accepted* (a version-1
    // document is a strict subset of version 2 — it has no groups — so there is nothing to
    // migrate), and the refusal boundary is `MINIMUM_FORMAT_VERSION`.
    //
    // Using the old expression here would silently turn into a test that a **valid** file is
    // accepted while claiming it is refused: `1` now passes, so `expectRefusal` would throw for
    // the wrong reason and the message assertions would never run. Both halves are asserted so
    // that cannot happen quietly.
    const error = expectRefusal(withField('formatVersion', MINIMUM_FORMAT_VERSION - 1), 'formatVersion');
    expect(error.message).toContain('older version');
    expect(error.message).toContain('no migration');
    expect(error.message).toContain(String(MINIMUM_FORMAT_VERSION));
    expect(error.message).toContain(String(CURRENT_FORMAT_VERSION));
  });

  it('ACCEPTS the previous version, and re-stamps it rather than migrating it', () => {
    // M12. This is the assertion that says "no migrations" survived the introduction of a second
    // accepted version, and it is easy to believe and cheap to check.
    //
    // `parse` takes parsed JSON, not a file name, so the version read is whatever the input says.
    // A version-1 document is read normally and comes back stamped `2` — a re-stamp, which is the
    // only difference, since a version-1 document has no `children` array anywhere to convert.
    const parsed = parse(withField('formatVersion', MINIMUM_FORMAT_VERSION));
    expect(parsed.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(parsed.pages.length).toBeGreaterThan(0);
    // Nothing was defaulted in: the node count and the asset table are exactly what was authored.
    expect(parsed.assets['asset_1']).toBeDefined();
  });

  it('a group document stamped with the OLD version is still refused for being new-flavoured', () => {
    // The asymmetry that makes accepting version 1 safe, and it is worth stating because the two
    // facts sit next to each other and look contradictory:
    //
    //   - version 1 is accepted;
    //   - a *group* is a version-2 concept.
    //
    // They are not contradictory: this build reads both, so it reads a group inside a file stamped
    // 1. What it does not do is let a **version-1 build** read it, and that is enforced by the
    // version check on that build's side, which this build can only mirror in the other direction.
    // So the test here is the half that is observable: the group survives the re-stamp, rather than
    // being dropped because the stamp looked old.
    const withGroup = withField('formatVersion', MINIMUM_FORMAT_VERSION);
    const pages = withGroup['pages'] as { objects: Record<string, unknown>[] }[];
    const page = pages[0];
    if (page === undefined) throw new Error('the builder produced no pages');
    page.objects = [
      {
        id: 'group_1',
        type: 'group',
        name: 'G',
        transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 2, scaleY: 2 },
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'normal',
        children: [],
      },
    ];
    const parsed = parse(withGroup);
    expect(parsed.formatVersion, 're-stamped on read').toBe(CURRENT_FORMAT_VERSION);
    const node = parsed.pages[0]?.objects[0];
    expect(node?.type, 'and the group is still there').toBe('group');
  });

  it('refuses a non-integer version', () => {
    expectRefusal(withField('formatVersion', 1.5), 'formatVersion');
    expectRefusal(withField('formatVersion', '1'), 'formatVersion');
  });

  it('refuses a missing version', () => {
    expectRefusal(withoutField('formatVersion'), 'formatVersion');
  });
});

// ---------------------------------------------------------------------------
// Required fields
// ---------------------------------------------------------------------------

describe('required fields', () => {
  it.each(['id', 'name', 'pageSize', 'assets', 'pages'])('refuses a missing %s', (field) => {
    expectRefusal(withoutField(field), field);
  });

  it('refuses an empty id', () => {
    expectRefusal(withField('id', ''), 'id');
  });

  it('refuses an id of the wrong type', () => {
    expectRefusal(withField('id', 42), 'id');
  });
});

// ---------------------------------------------------------------------------
// Page size
// ---------------------------------------------------------------------------

describe('page size', () => {
  it('refuses a zero or negative dimension', () => {
    expectRefusal(withField('pageSize/width', 0), 'pageSize.width');
    expectRefusal(withField('pageSize/height', -1), 'pageSize.height');
  });

  it('refuses `px`, which is not a physical unit', () => {
    // A document authored in px has no defined print size, and the field is a *physical*
    // unit precisely so "A4" survives a round trip.
    const error = expectRefusal(withField('pageSize/unit', 'px'), 'pageSize.unit');
    expect(error.message).toContain('physical unit');
  });

  it('refuses an unknown unit', () => {
    expectRefusal(withField('pageSize/unit', 'furlong'), 'pageSize.unit');
  });

  it('refuses an unknown orientation', () => {
    expectRefusal(withField('pageSize/orientation', 'sideways'), 'pageSize.orientation');
  });

  it('refuses an undeclared field', () => {
    expectRefusal(withField('pageSize/margins', {}), 'pageSize.margins');
  });
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

describe('pages', () => {
  it('refuses an empty page list', () => {
    // A document with no pages has nothing to render and no place to put an object.
    expectRefusal(withField('pages', []), 'pages');
  });

  it('refuses a missing page field', () => {
    expectRefusal(withoutField('pages/0/id'), 'pages[0].id');
    expectRefusal(withoutField('pages/0/background'), 'pages[0].background');
    expectRefusal(withoutField('pages/0/objects'), 'pages[0].objects');
  });

  it('refuses an undeclared page field', () => {
    // `grid` and `guides` are in §6.1's sketch. They arrive as schema fields with a version
    // bump; until then they are unknown, and unknown is refused rather than ignored.
    expectRefusal(withField('pages/0/grid', { spacing: 8 }), 'pages[0].grid');
  });
});

// ---------------------------------------------------------------------------
// Objects and shapes
// ---------------------------------------------------------------------------

describe('object types', () => {
  it('refuses an unknown type, naming it', () => {
    // ADR 0003's rule: an unrecognised kind must not come back as an object that renders as
    // nothing. Refusing is the only alternative that keeps the promise.
    const error = expectRefusal(
      withField('pages/0/objects/0/type', 'sticker'),
      'pages[0].objects[0].type',
    );
    expect(error.message).toContain('unknown object type "sticker"');
  });

  it('refuses an unknown shape kind, naming it', () => {
    const root = withField('pages/0/objects/0/shape', { kind: 'polygon' });
    const error = expectRefusal(root, 'pages[0].objects[0].shape.kind');
    expect(error.message).toContain('unknown shape kind "polygon"');
  });

  it('refuses a rect field on a kind that has none', () => {
    // `{ kind: 'ellipse', cornerRadius: 8 }` is meaningless, and accepting it would store a
    // field no renderer ever reads -- a value in the document that means nothing.
    const root = withField('pages/0/objects/0/shape', { kind: 'ellipse', cornerRadius: 8 });
    expectRefusal(root, 'pages[0].objects[0].shape.cornerRadius');
  });

  it('refuses a negative corner radius', () => {
    expectRefusal(
      withField('pages/0/objects/0/shape', { kind: 'rect', cornerRadius: -1 }),
      'pages[0].objects[0].shape.cornerRadius',
    );
  });

  it('refuses a missing cornerRadius on a rect', () => {
    expectRefusal(
      withField('pages/0/objects/0/shape', { kind: 'rect' }),
      'pages[0].objects[0].shape.cornerRadius',
    );
  });

  it('refuses an undeclared node field', () => {
    expectRefusal(withField('pages/0/objects/0/cornerRadius', 4), 'pages[0].objects[0].cornerRadius');
  });

  it('preserves `extensions` verbatim, including fields it has never heard of', () => {
    // The one declared opaque bag, and therefore the only forward-compat path a node has.
    // Preserving it is not the same as understanding it.
    const bag = { 'com.example.plugin': { anything: [1, 2, { nested: true }] } };
    const doc = parse(withField('pages/0/objects/0/extensions', bag));
    expect(doc.pages[0]?.objects[0]?.extensions).toEqual(bag);
  });

  it('refuses a non-object `extensions`', () => {
    expectRefusal(withField('pages/0/objects/0/extensions', 'nope'), 'pages[0].objects[0].extensions');
  });
});

describe('shared node fields', () => {
  it.each(['id', 'name', 'transform', 'visible', 'locked', 'opacity', 'blendMode', 'type'])(
    'refuses a missing %s',
    (field) => {
      expectRefusal(withoutField(`pages/0/objects/0/${field}`), `pages[0].objects[0].${field}`);
    },
  );

  it('refuses an opacity outside 0..1', () => {
    expectRefusal(withField('pages/0/objects/0/opacity', 1.5), 'pages[0].objects[0].opacity');
    expectRefusal(withField('pages/0/objects/0/opacity', -0.1), 'pages[0].objects[0].opacity');
  });

  it('refuses an unknown blend mode', () => {
    expectRefusal(withField('pages/0/objects/0/blendMode', 'dissolve'), 'blendMode');
  });

  it('refuses a boolean of the wrong type', () => {
    expectRefusal(withField('pages/0/objects/0/visible', 'yes'), 'pages[0].objects[0].visible');
  });
});

describe('transforms', () => {
  it('refuses a negative width or height', () => {
    // Zero is legal -- a horizontal line has height 0 -- and negative is not. That
    // asymmetry is what the geometry contract rests on, so the boundary enforces it.
    expectRefusal(
      withField('pages/0/objects/0/transform/width', -1),
      'pages[0].objects[0].transform.width',
    );
    expectRefusal(
      withField('pages/0/objects/0/transform/height', -0.5),
      'pages[0].objects[0].transform.height',
    );
  });

  it('accepts zero width and height, because a line has them', () => {
    const root = withField('pages/0/objects/0/transform', {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    });
    const doc = parse(root);
    expect(doc.pages[0]?.objects[0]?.transform).toMatchObject({ width: 0, height: 0 });
  });

  it('refuses a zero scale, which makes the transform non-invertible', () => {
    // Hit testing inverts the transform for every object type, so a zero scale is not a
    // rendering state -- it is a document that cannot be interacted with.
    for (const axis of ['scaleX', 'scaleY']) {
      const root = withField(`pages/0/objects/0/transform/${axis}`, 0);
      const error = expectRefusal(root, `pages[0].objects[0].transform.${axis}`);
      expect(error.message).toContain('non-invertible');
    }
  });

  it('refuses a non-finite number', () => {
    // `JSON.parse` cannot produce NaN or Infinity, so this is reached only through a direct
    // call -- which is exactly the boundary the type system does not police, and it must
    // not be trusted to.
    expectRefusal(withField('pages/0/objects/0/transform/x', Number.NaN), 'transform.x');
    expectRefusal(withField('pages/0/objects/0/transform/x', Number.POSITIVE_INFINITY), 'transform.x');
  });

  it('refuses an undeclared transform field', () => {
    expectRefusal(
      withField('pages/0/objects/0/transform/skewX', 1),
      'pages[0].objects[0].transform.skewX',
    );
  });
});

describe('appearance', () => {
  it('refuses an unknown paint type', () => {
    const root = withField('pages/0/objects/0/fill', { type: 'gradient', color: '#fff' });
    expectRefusal(root, 'pages[0].objects[0].fill.type');
  });

  it('refuses a missing paint colour', () => {
    expectRefusal(withField('pages/0/objects/0/fill', { type: 'solid' }), 'fill.color');
  });

  it('accepts a colour it cannot render', () => {
    // Deliberate, and the counterpart to refusing bad data: an unrenderable colour is a
    // *rendering* state, and refusing the file over it would discard the user's document to
    // avoid a cosmetic complaint. The renderer shows nothing; the document survives.
    const root = withField('pages/0/objects/0/fill', { type: 'solid', color: 'not-a-colour' });
    const doc = parse(root);
    const node = doc.pages[0]?.objects[0];
    expect(node?.type === 'shape' ? node.fill?.color : null).toBe('not-a-colour');
  });

  it('refuses an unsupported stroke alignment', () => {
    // The type carries all three so a document can express intent, but only `inside`
    // renders. Refusing here means the user is told at *load* rather than when a renderer
    // throws mid-projection.
    for (const align of ['center', 'outside']) {
      const root = withField('pages/0/objects/0/stroke', {
        paint: { type: 'solid', color: '#000000' },
        width: 1,
        align,
      });
      const error = expectRefusal(root, 'pages[0].objects[0].stroke.align');
      expect(error.message).toContain('not supported by this build');
    }
  });

  it('accepts `inside`', () => {
    const root = withField('pages/0/objects/0/stroke', {
      paint: { type: 'solid', color: '#000000' },
      width: 0,
      align: 'inside',
    });
    expect(parse(root).pages[0]?.objects[0]).toHaveProperty('stroke');
  });
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function textDocument(text: unknown): Record<string, unknown> {
  // Mutated in place, so the caller keeps a plain `Record<string, unknown>` and can reach
  // into it afterwards when a case needs a second field changed.
  const root = validDocument();
  const objects = (root['pages'] as Array<{ objects: Record<string, unknown>[] }>)[0]?.objects;
  const target = objects?.[0] as Record<string, unknown>;
  delete target['shape'];
  target['type'] = 'textFrame';
  target['text'] = text;
  return root;
}

describe('rich text', () => {
  it('refuses a frame with no blocks', () => {
    // An empty frame is one empty paragraph, never an empty list: the caret needs somewhere
    // to live and `Enter` needs somewhere to go (ADR 0003).
    const error = expectRefusal(textDocument({ blocks: [] }), 'pages[0].objects[0].text.blocks');
    expect(error.message).toContain('at least one block');
  });

  it('refuses an unknown block kind', () => {
    const root = textDocument({ blocks: [{ kind: 'heading', runs: [{ text: 'x' }] }] });
    const error = expectRefusal(root, 'pages[0].objects[0].text.blocks[0].kind');
    expect(error.message).toContain('unknown block kind "heading"');
  });

  it('refuses an undeclared block field', () => {
    const root = textDocument({
      blocks: [{ kind: 'paragraph', runs: [{ text: 'x' }], indent: 4 }],
    });
    expectRefusal(root, 'pages[0].objects[0].text.blocks[0].indent');
  });

  it('refuses an unknown paragraph alignment', () => {
    const root = textDocument({
      blocks: [{ kind: 'paragraph', align: 'justify-all', runs: [{ text: 'x' }] }],
    });
    expectRefusal(root, 'pages[0].objects[0].text.blocks[0].align');
  });

  it('refuses a run with no text', () => {
    // Absent text is not "empty text". One spelling of "empty" is what keeps run equality
    // total, and equality is what decides whether a command is a no-op.
    const root = textDocument({ blocks: [{ kind: 'paragraph', runs: [{ format: { bold: true } }] }] });
    expectRefusal(root, 'runs[0].text');
  });

  it('refuses a `false` format flag', () => {
    // One encoding of "not bold": present-and-true or absent. A `false` would give every run
    // two spellings and make equality non-total.
    const root = textDocument({
      blocks: [{ kind: 'paragraph', runs: [{ text: 'x', format: { bold: false } }] }],
    });
    const error = expectRefusal(root, 'runs[0].format.bold');
    expect(error.message).toContain('must be true or absent');
  });

  it('refuses an unknown format flag', () => {
    const root = textDocument({
      blocks: [{ kind: 'paragraph', runs: [{ text: 'x', format: { superscript: true } }] }],
    });
    expectRefusal(root, 'superscript');
  });

  it('refuses an undeclared run field', () => {
    const root = textDocument({
      blocks: [{ kind: 'paragraph', runs: [{ text: 'x', style: { bold: true } }] }],
    });
    // `run.style` is what §6.1's sketch calls it; the model calls it `format`. Naming the
    // mismatch is the point of the error, not tolerating it.
    expectRefusal(root, 'runs[0].style');
  });

  it('normalises a paragraph with no runs into one empty run', () => {
    // Not a refusal: the canonical form of an empty paragraph is one empty run, and
    // `normalizeRichText` produces it. Refusing here would mean a file could not express
    // "an empty paragraph", which is a state the editor can definitely produce.
    const doc = parse(textDocument({ blocks: [{ kind: 'paragraph', runs: [] }] }));
    const node = doc.pages[0]?.objects[0];
    if (node?.type !== 'textFrame') throw new Error('unreachable');
    expect(node.text.blocks[0]?.runs).toEqual([{ text: '' }]);
  });

  it('refuses an undeclared text style field', () => {
    const root = textDocument({ blocks: [{ kind: 'paragraph', runs: [{ text: 'x' }] }] });
    const objects = (root['pages'] as Array<{ objects: Record<string, unknown>[] }>)[0]?.objects;
    const target = objects?.[0] as Record<string, unknown>;
    target['style'] = { fontSize: 16, fontWeight: 700 };
    expectRefusal(root, 'pages[0].objects[0].style.fontWeight');
  });

  it('refuses a non-positive font size or line height', () => {
    const blocks = { blocks: [{ kind: 'paragraph', runs: [{ text: 'x' }] }] };
    for (const [field, value] of [
      ['fontSize', 0],
      ['fontSize', -12],
      ['lineHeight', 0],
    ] as const) {
      const root = textDocument(blocks);
      const objects = (root['pages'] as Array<{ objects: Record<string, unknown>[] }>)[0]?.objects;
      const target = objects?.[0] as Record<string, unknown>;
      target['style'] = { [field]: value };
      expectRefusal(root, `style.${field}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

describe('assets', () => {
  it('refuses an unknown asset kind', () => {
    const root = withField('assets/asset_1/kind', 'video');
    const error = expectRefusal(root, 'assets.asset_1.kind');
    expect(error.message).toContain('unknown asset kind "video"');
  });

  it('refuses a zero or negative intrinsic size', () => {
    // ADR 0006's invariant, re-checked at the boundary: an asset that cannot paint must
    // not be representable, whatever produced it.
    expectRefusal(withField('assets/asset_1/intrinsicWidth', 0), 'intrinsicWidth');
    expectRefusal(withField('assets/asset_1/intrinsicHeight', -2), 'intrinsicHeight');
  });

  it('refuses a record carrying both storage arms', () => {
    // Exactly one arm. A record with both has no defined meaning, and guessing which was
    // meant is how bytes get lost.
    const root = withField('assets/asset_1/data', {
      inline: 'data:image/png;base64,AAA',
      external: './a.png',
    });
    const error = expectRefusal(root, 'assets.asset_1.data');
    expect(error.message).toContain('exactly one');
  });

  it('refuses a record carrying neither arm', () => {
    const root = withField('assets/asset_1/data', {});
    const error = expectRefusal(root, 'assets.asset_1.data');
    expect(error.message).toContain('neither');
  });

  it('refuses an undeclared data field', () => {
    const root = withField('assets/asset_1/data', { blob: '...' });
    expectRefusal(root, 'assets.asset_1.data.blob');
  });

  it('preserves an external reference exactly, and never resolves it', () => {
    const reference = './assets/файл with spaces & a query?.png';
    const root = withField('assets/asset_1/data', { external: reference });
    const doc = parse(root);
    const asset = doc.assets['asset_1'];
    expect(asset).toBeDefined();
    expect('external' in (asset?.data ?? {})).toBe(true);
    expect((asset?.data as { external: string }).external).toBe(reference);
  });

  it('accepts an inline payload it cannot decode', () => {
    // The counterpart to accepting an unrenderable colour. A broken image is a *loading*
    // state the document already knows how to show (ADR 0006 §5); refusing the file over it
    // would discard the user's document to avoid a cosmetic complaint.
    const doc = parse(withField('assets/asset_1/data', { inline: 'not-a-data-url' }));
    expect(doc.assets['asset_1']).toBeDefined();
  });

  it('accepts an asset record that no object references', () => {
    // Orphans are legal: they survive undo (ADR 0006 §5) and therefore survive a save.
    // Garbage collection is not this milestone's job, and a format that silently dropped
    // them would make undo lossy.
    const root = validDocument();
    const assets = root['assets'] as Record<string, unknown>;
    assets['asset_orphan'] = {
      kind: 'image',
      mime: 'image/png',
      intrinsicWidth: 1,
      intrinsicHeight: 1,
      data: { inline: 'data:image/png;base64,AAA' },
    };
    expect(Object.keys(parse(root).assets).sort()).toEqual(['asset_1', 'asset_orphan']);
  });

  it('refuses an image whose asset reference resolves to nothing', () => {
    // Checked at load rather than left to the renderer, so opening a document with a
    // dangling reference is a refusal with a path rather than an image that silently renders
    // as a placeholder with no explanation anywhere.
    const root = validDocument();
    const objects = (root['pages'] as Array<{ objects: Record<string, unknown>[] }>)[0]?.objects;
    const target = objects?.[0] as Record<string, unknown>;
    delete target['shape'];
    target['type'] = 'image';
    target['asset'] = 'asset_missing';
    const error = expectRefusal(root, 'pages[0].objects[0].asset');
    expect(error.message).toContain('asset_missing');
  });

  it('refuses an empty asset id', () => {
    const root = validDocument();
    const assets = root['assets'] as Record<string, unknown>;
    assets[''] = assets['asset_1'];
    expectRefusal(root, 'assets');
  });
});

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

describe('ids', () => {
  it('refuses two objects sharing an id', () => {
    // Not cosmetic: `mapNodesById` resolves the collision to whichever it visits first, so
    // an edit to one object would silently apply to the other.
    const root = validDocument();
    const objects = (root['pages'] as Array<{ objects: Record<string, unknown>[] }>)[0]?.objects;
    (objects?.[0] as Record<string, unknown>)['id'] = 'page_1';
    const error = expectRefusal(root, 'id');
    expect(error.message).toContain('page_1');
  });

  it('refuses two pages sharing an id', () => {
    const root = validDocument();
    const pages = root['pages'] as Array<Record<string, unknown>>;
    const second = pages[0];
    if (second === undefined) throw new Error('unreachable');
    pages.push({ ...second, name: 'Two' });
    expectRefusal(root, 'page_1');
  });

  it('refuses a page id equal to the document id', () => {
    // Uniqueness is across the *whole* document, not per collection, because the generator
    // keeps one counter per prefix and a page and an object are both addressed by id.
    const root = withField('pages/0/id', 'doc_1');
    expectRefusal(root, 'doc_1');
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe('isolation from the input', () => {
  it('does not share nested objects with the input', () => {
    // Every object is rebuilt field by field, so a parsed document shares nothing with the
    // data it came from. This is not paranoia: `serialize` copying a nested reference would
    // put the same object in two documents, and the first edit through the command funnel
    // would mutate the other.
    const input = validDocument() as unknown as PersistedDocument;
    const doc = parse(input);
    const node = doc.pages[0]?.objects[0];
    if (node === undefined) throw new Error('unreachable');
    node.transform.x = 999;
    const inputNode = (
      input.pages[0]?.objects[0] as unknown as { transform: { x: number } }
    );
    expect(inputNode.transform.x).toBe(1);
  });

  it('produces a document that validates against the model invariants', () => {
    // The two checks are independent and this ties them together: the format boundary
    // accepting a document is not the same as the model accepting it, and a gap between
    // them would let an invalid document into the app.
    const doc = parse(validDocument());
    expect(validateDocument(doc)).toEqual([]);
  });
});