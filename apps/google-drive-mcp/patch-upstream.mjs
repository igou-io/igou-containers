import { readFileSync, writeFileSync } from 'node:fs';

// Piotr 2.13.0 uses two Zod 3 APIs. Adapt them for the patched Zod 4 dependency.
// Count each replacement so an upstream update cannot silently apply a stale patch.
const file = 'node_modules/@piotr-agier/google-drive-mcp/dist/index.js';
let source = readFileSync(file, 'utf8');
for (const [before, after, expected] of [
  ['.error.errors', '.error.issues', 124],
  ['required_error:', 'error:', 10],
]) {
  const count = source.split(before).length - 1;
  if (count !== expected) {
    throw new Error(`Review the upstream Zod patch: expected ${expected} occurrences of ${before}, found ${count}`);
  }
  source = source.replaceAll(before, after);
}
writeFileSync(file, source);
