/**
 * Remove ONNX Runtime WASM files from dist after build.
 *
 * These files are ~28MB each and exceed Cloudflare Pages' 25MB file limit.
 * At runtime, onnxruntime-web loads them from jsDelivr CDN instead
 * (configured via ort.env.wasm.wasmPaths in ocrEngine.ts).
 */
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const assetsDir = join(import.meta.dirname, '..', 'dist', 'assets');

try {
  const files = readdirSync(assetsDir);
  let removed = 0;
  for (const file of files) {
    if (/^ort-wasm.*\.(wasm|mjs|js)$/.test(file)) {
      unlinkSync(join(assetsDir, file));
      console.log(`Removed ${file} (served from CDN at runtime)`);
      removed++;
    }
  }
  if (removed === 0) {
    console.log('No ONNX WASM files found in dist/assets — already clean.');
  } else {
    console.log(`Cleaned ${removed} ONNX WASM file(s) from dist.`);
  }
} catch (err) {
  console.error('Failed to clean ONNX WASM from dist:', err);
  process.exit(1);
}
