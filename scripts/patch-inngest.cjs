/**
 * Postinstall script to patch inngest for @inngest/agent-kit compatibility.
 * 
 * Problem: @inngest/agent-kit@0.12.1 expects getAsyncCtx() to return a store
 * with `store.ctx.step`, but inngest@3.54.x stores it as `store.execution.ctx.step`.
 * 
 * This script patches:
 * 1. inngest/package.json exports map — adds subpath exports for internal modules
 *    that agent-kit imports (components/InngestFunction, helpers/errors, types)
 * 2. inngest/components/execution/als.js & als.cjs — adds a ctx shim to the store object
 */
const fs = require('fs');
const path = require('path');

// Root node_modules path
const rootNodeModules = path.join(__dirname, '..', 'node_modules');

// --- Patch 1: Add missing subpath exports to inngest/package.json ---
const pkgPath = path.join(rootNodeModules, 'inngest', 'package.json');

if (!fs.existsSync(pkgPath)) {
  console.log('[patch-inngest] inngest not installed yet, skipping');
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const exportsMap = pkg.exports || {};

const subpaths = {
  './components/InngestFunction': {
    types: { import: './components/InngestFunction.d.ts', require: './components/InngestFunction.d.cts' },
    import: './components/InngestFunction.js',
    require: './components/InngestFunction.cjs',
  },
  './helpers/errors': {
    types: { import: './helpers/errors.d.ts', require: './helpers/errors.d.cts' },
    import: './helpers/errors.js',
    require: './helpers/errors.cjs',
  },
  './types': {
    types: { import: './types.d.ts', require: './types.d.cts' },
    import: './types.js',
    require: './types.cjs',
  },
};

let patchedExports = false;
for (const [key, value] of Object.entries(subpaths)) {
  if (!exportsMap[key]) {
    exportsMap[key] = value;
    patchedExports = true;
  }
}

if (patchedExports) {
  pkg.exports = exportsMap;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('[patch-inngest] Patched inngest package.json exports');
}

// --- Patch 2: Shim getAsyncCtx to bridge store.execution.ctx → store.ctx ---
const filesToPatch = [
  path.join(rootNodeModules, 'inngest', 'components', 'execution', 'als.js'),
  path.join(rootNodeModules, 'inngest', 'components', 'execution', 'als.cjs'),
];

filesToPatch.forEach((alsPath) => {
  if (!fs.existsSync(alsPath)) {
    console.log(`[patch-inngest] File not found: ${alsPath}, skipping`);
    return;
  }

  const alsContent = fs.readFileSync(alsPath, 'utf8');
  const shimMarker = '// PATCHED: ctx shim for agent-kit compatibility';

  if (!alsContent.includes(shimMarker)) {
    // Regex matches the getAsyncCtx declaration and its inner body returning getAsyncLocalStorage...
    const patchedAls = alsContent.replace(
      /const getAsyncCtx = async \(\) => \{[\s\S]*?return getAsyncLocalStorage\(\)\.then\(\(als\) => als\.getStore\(\)\);[\s\S]*?\};/,
      `const getAsyncCtx = async () => {
\t${shimMarker}
\tconst store = await getAsyncLocalStorage().then((als) => als.getStore());
\tif (store && typeof store === "object" && "execution" in store && !("ctx" in store)) {
\t\tObject.defineProperty(store, "ctx", {
\t\t\tget() { return this.execution?.ctx; },
\t\t\tconfigurable: true,
\t\t\tenumerable: true,
\t\t});
\t}
\treturn store;
};`
    );
    fs.writeFileSync(alsPath, patchedAls);
    console.log(`[patch-inngest] Patched ${path.basename(alsPath)} with ctx shim`);
  } else {
    console.log(`[patch-inngest] ${path.basename(alsPath)} already patched, skipping`);
  }
});

console.log('[patch-inngest] Done');
