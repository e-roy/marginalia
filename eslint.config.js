import babelParser from '@babel/eslint-parser'
import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

/**
 * Why there is no typescript-eslint here.
 *
 * This project is on TypeScript 7, and that package's main entry exports exactly two
 * things — `version` and `versionMajorMinor`. The compiler API moved behind
 * `typescript/unstable/*` with a different shape. typescript-eslint's parser is built
 * on `ts.createSourceFile` / `ts.createProgram` read off the main entry, so on TS 7 it
 * is inert rather than merely unsupported: those functions are `undefined`. Verified
 * 2026-08-20 against typescript-eslint 8.67.0 (its peer range is `<6.1.0` anyway).
 *
 * So Babel parses the TypeScript, reading the syntax without needing the compiler. The
 * trade is that no type-aware rules are available, which costs less here than it
 * sounds: `tsconfig.json` already runs strict with `noUnusedLocals`,
 * `noUnusedParameters`, `noUncheckedIndexedAccess` and `noFallthroughCasesInSwitch`.
 * `pnpm typecheck` owns everything that needs types; ESLint owns what types cannot see
 * — chiefly the React hooks rules, which are the reason to run a linter on this
 * codebase at all. Revisit when typescript-eslint targets the TS 7 API.
 */

/**
 * Babel 8 removed `allExtensions` / `isTSX` in favour of deciding JSX by file
 * extension, but that detection does not survive the trip through
 * `@babel/eslint-parser`, so `.tsx` files fail to parse on the first `<`. JSX is
 * therefore switched on explicitly, per extension.
 *
 * Per extension rather than everywhere, because enabling JSX for plain `.ts` makes a
 * generic arrow like `<T>(x) => x` ambiguous.
 */
function typescript({ jsx = false } = {}) {
  return {
    parser: babelParser,
    parserOptions: {
      requireConfigFile: false, // No Babel config in this project — Vite has its own.
      babelOptions: {
        presets: ['@babel/preset-typescript'],
        plugins: jsx ? ['@babel/plugin-syntax-jsx'] : [],
      },
    },
  }
}

/**
 * Two core rules that cannot work on Babel-parsed TypeScript, because ESLint's scope
 * analysis has no idea what a type is: every `import type` reads as unused, and every
 * type name reads as undefined. Both are already covered properly by `tsc`.
 */
const CORE_RULES_TYPES_OWN = {
  'no-unused-vars': 'off',
  'no-undef': 'off',
}

export default [
  {
    ignores: [
      'dist/**',
      'dev-dist/**',
      'functions/lib/**', // compiled output
      'public/**',
    ],
  },

  js.configs.recommended,

  // ---------------------------------------------------------------- app (src/)
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ...typescript(),
      // `serviceworker` because vite-plugin-pwa's registration flow reaches for
      // ServiceWorkerRegistration and friends.
      globals: { ...globals.browser, ...globals.serviceworker },
    },
  },
  {
    files: ['src/**/*.tsx'],
    languageOptions: {
      ...typescript({ jsx: true }),
      globals: globals.browser,
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      '@stylistic': stylistic,
    },
    rules: {
      ...CORE_RULES_TYPES_OWN,
      ...reactHooks.configs.recommended.rules,
      ...reactRefresh.configs.vite.rules,

      // House style: no semicolons, single quotes, double quotes in JSX attributes.
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/jsx-quotes': ['error', 'prefer-double'],
    },
  },
  {
    /**
     * Registry code. `shadcn add` writes these files and rewrites them wholesale every
     * time another component is pulled in, so local edits here do not survive — which
     * makes two of these rules pure churn rather than quality:
     *
     * - `quotes`: the registry emits double quotes.
     * - `only-export-components`: every shadcn component exports its `cva` variants
     *   alongside itself, and `allowConstantExport` does not cover a call expression.
     *   The cost is slightly coarser hot-reload in these files, never correctness.
     *
     * Everything that catches actual bugs — the hooks rules included — still applies.
     */
    files: ['src/components/ui/**'],
    rules: {
      '@stylistic/quotes': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },

  // ----------------------------------------------------- cloud functions (Node)
  {
    files: ['functions/src/**/*.ts'],
    languageOptions: {
      ...typescript(),
      globals: globals.node,
      sourceType: 'module', // TypeScript source; tsc emits CommonJS from it.
    },
    plugins: { '@stylistic': stylistic },
    rules: {
      ...CORE_RULES_TYPES_OWN,
      // The functions package keeps semicolons — see functions/src.
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
    },
  },

  // ------------------------------------------------------------ build scripts
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: { '@stylistic': stylistic },
    rules: {
      // Plain JavaScript, so the core rules work properly and are worth keeping.
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
    },
  },

  // ------------------------------------------------------------ config files
  {
    files: ['*.config.{js,ts}', 'vite.config.ts'],
    languageOptions: {
      ...typescript(),
      globals: globals.node,
    },
    rules: CORE_RULES_TYPES_OWN,
  },
]
