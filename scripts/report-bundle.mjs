/**
 * scripts/report-bundle.mjs — baseline sizes of the on-demand conversion chunks.
 *
 * The `docx` and `fflate` libraries are never on the app's critical path: they
 * load on first import/export (js/editor/docxExport.js, js/editor/ooxml.js).
 * This script bundles each in isolation with Vite's JS API and reports the raw
 * and gzipped sizes so regressions in the lazy bundle budget are caught.
 *
 * Uses only existing devDependencies (vite) and node:zlib — no new deps.
 */

import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = mkdtempSync(join(process.cwd(), '.bundle-tmp-'));

const modules = {
    'docx.js': 'import * as docx from "docx"; globalThis.__scribenBundle = docx;',
    'fflate.js': 'import * as fflate from "fflate"; globalThis.__scribenBundle = fflate;'
};

for (const [name, code] of Object.entries(modules)) {
    writeFileSync(join(dir, name), code);
}

try {
    await build({
        logLevel: 'error',
        configFile: false,
        build: {
            write: true,
            outDir: join(dir, 'out'),
            minify: 'oxc',
            rollupOptions: {
                input: Object.fromEntries(
                    Object.keys(modules).map(name => [name.replace('.js', ''), join(dir, name)])
                ),
                output: { entryFileNames: '[name].js', format: 'es' }
            }
        }
    });

    console.log('On-demand conversion chunks (baseline):');
    for (const name of Object.keys(modules)) {
        const file = join(dir, 'out', name);
        const raw = readFileSync(file);
        const gzip = gzipSync(raw);
        const kib = n => (n / 1024).toFixed(1);
        console.log(`  ${name.replace('.js', '').padEnd(8)} raw ${kib(raw.length).padStart(7)} KiB   gzip ${kib(gzip.length).padStart(7)} KiB`);
    }
} finally {
    rmSync(dir, { recursive: true, force: true });
}