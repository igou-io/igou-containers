const assert = require('node:assert/strict');
const { test } = require('node:test');
const { selectApps } = require('../select-build-apps.cjs');

test('scheduled builds select all remaining apps', () => {
  assert.deepEqual(selectApps(['codex', 'squid'], '*'), ['codex', 'squid']);
});
test('image removals are excluded from PR and push build matrices', () => {
  assert.deepEqual(selectApps(['codex', 'squid'], 'mcpo acp-codex-runner codex acp-codex-control-plane'), ['codex']);
});
test('manual dispatch validates app names and rejects path traversal', () => {
  assert.throws(() => selectApps(['codex'], '../codex', true), /Unknown app/);
  assert.deepEqual(selectApps(['codex'], 'codex codex', true), ['codex']);
});
