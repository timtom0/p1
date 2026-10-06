// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Module boundary rules (docs/ARCHITECTURE.md §8.1).
 *
 * The dependency direction is:
 *
 *   platform → ui → editor → render → model → core
 *
 * `model` and `core` are the load-bearing constraint: they are what makes "the
 * DOM is a projection of the model" true rather than aspirational. This config
 * turns that into a build failure.
 *
 * Cross-layer imports are always relative (`../render/...`), and no source file
 * sits deeper than `src/<layer>/<module>/<file>.ts`, so matching on the relative
 * prefix is sufficient and does not need path resolution.
 */

/** Layer directories, in dependency order. */
/**
 * Layer directories.
 *
 * The order is the dependency order for the *chain* `ui -> editor -> render -> model -> core`,
 * with `persist` listed after `ui` for readability even though it is a leaf: it depends only
 * on `core` and `model`, and nothing depends on it except the file boundary in `ui/`.
 */
const LAYERS = ['core', 'model', 'render', 'editor', 'ui', 'persist', 'platform'];

/** For a file in `from`, the layers it is allowed to import. */
const ALLOWED_IMPORTS = {
  core: ['core'],
  model: ['core', 'model'],
  render: ['core', 'model', 'render'],
  editor: ['core', 'model', 'render', 'editor'],
  // `persist` is reachable only from `ui`, and only for the file boundary. Nothing in
  // `render`, `editor` or `model` may know the format exists -- if the editor ever needs to
  // serialize, that is a signal the seam is in the wrong place, not that the rule should
  // widen. See docs/ARCHITECTURE.md 8.1.
  ui: ['core', 'model', 'editor', 'ui', 'persist'],
  persist: ['core', 'model', 'persist'],
  platform: ['core', 'platform'],
};

/** Relative prefixes that could reach each layer from one or two levels up. */
function forbiddenImports(from) {
  const forbidden = LAYERS.filter((layer) => !ALLOWED_IMPORTS[from].includes(layer));
  return forbidden.flatMap((layer) => [`../${layer}/*`, `../../${layer}/*`, `../../../${layer}/*`]);
}

/** DOM type names that must never appear in the model or core layers. */
const DOM_TYPE_NAMES =
  '^(HTMLElement|HTMLDivElement|HTMLImageElement|HTMLCanvasElement|Element|SVGElement|CSSStyleDeclaration|Window|Event|MouseEvent|KeyboardEvent|NodeList|HTMLCollection|DocumentFragment)$';

const boundaryMessage = (from, layer) =>
  `Layer boundary violation: "${from}" must not import from "${layer}". ` +
  `Allowed: ${ALLOWED_IMPORTS[from].join(', ')}. See docs/ARCHITECTURE.md §8.1.`;

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  // Per-layer import direction.
  ...Object.entries(ALLOWED_IMPORTS).map(([layer]) => ({
    files: [`src/${layer}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: forbiddenImports(layer).map((group) => ({
            group: [group],
            message: boundaryMessage(layer, group.replace(/^\.\.\/?|\/\*$/g, '').replace(/\.\.\//g, '')),
          })),
        },
      ],
    },
  })),
  // The composition root is the single place where layers are wired together —
  // constructing a DocumentView and a Viewport is precisely its job, so it is
  // exempt from the ui -> render restriction. Everything else in ui/ must go
  // through stores, selectors and commands. See docs/ARCHITECTURE.md §8.1.
  {
    files: ['src/ui/app.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // The model and core layers are DOM-free.
  {
    files: ['src/core/**/*.ts', 'src/model/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'core/model must not reference the DOM.' },
        { name: 'document', message: 'core/model must not reference the DOM.' },
        { name: 'localStorage', message: 'core/model must not reference the DOM.' },
        { name: 'requestAnimationFrame', message: 'core/model must not reference the DOM.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: `TSTypeReference > Identifier[name=/${DOM_TYPE_NAMES}/]`,
          message:
            'core/model must not reference DOM types. The document model is plain data; ' +
            'src/render projects it into the DOM.',
        },
      ],
    },
  },
);