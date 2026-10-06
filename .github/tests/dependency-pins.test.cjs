const assert = require('node:assert/strict');
const { test } = require('node:test');
const { recapture, prepare } = require('../prepare-dependency-pins.cjs');
const zero = '0'.repeat(64);
const sha = 'a'.repeat(64);
const codex = `ARG CODEX_VERSION="0.157.1"\nARG CODEX_SHA256_X64="${zero}"\nARG CODEX_SHA256_ARM64="${zero}"\n`;

function manifest() {
  return `${sha}  codex-package-x86_64-unknown-linux-musl.tar.gz\n${sha}  codex-package-aarch64-unknown-linux-musl.tar.gz\n`;
}

test('Codex version bumps refresh both architecture pins and are idempotent', async () => {
  const fetcher = async url => {
    assert.equal(url, 'https://github.com/openai/codex/releases/download/rust-v0.157.1/codex-package_SHA256SUMS');
    return new Response(manifest());
  };
  const updated = await recapture('apps/codex/Containerfile', codex, fetcher);
  assert.equal(updated.match(new RegExp(sha, 'g')).length, 2);
  assert.equal(await recapture('apps/codex/Containerfile', updated, fetcher), updated);
});

test('missing or duplicate upstream checksums fail without producing a patch', async () => {
  await assert.rejects(recapture('apps/codex/Containerfile', codex, async () => new Response('')), /Expected one checksum/);
  await assert.rejects(recapture('apps/codex/Containerfile', codex, async () => new Response(manifest() + manifest())), /Expected one checksum/);
});

test('rejects injected versions before any network request', async () => {
  await assert.rejects(recapture('apps/codex/Containerfile', codex.replace('0.157.1', '../secrets'), () => { throw new Error('Network should not run'); }), /Invalid CODEX_VERSION/);
});

test('Cursor downloads only the two fixed architecture URLs', async () => {
  const content = `ARG CURSOR_AGENT_VERSION="2026.10.01-e373342"\nARG CURSOR_AGENT_SHA256_X64="${zero}"\nARG CURSOR_AGENT_SHA256_ARM64="${zero}"\n`;
  const urls = [];
  const updated = await recapture('apps/cursor-agent-cli/Containerfile', content, async url => { urls.push(url); return new Response('binary'); });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/linux\/x64\/agent-cli-package\.tar\.gz$/);
  assert.match(urls[1], /\/linux\/arm64\/agent-cli-package\.tar\.gz$/);
  assert.ok(!updated.includes(zero));
});

test('Omnigent refreshes the archive pin while retaining the selected image', async () => {
  const content = `ARG OMNIGENT_VERSION=v0.17.0\nFROM image:v0.17.0\nADD --checksum=sha256:${zero} \\\n https://example.invalid/source\n`;
  const updated = await recapture('apps/omnigent-slack/Containerfile', content, async url => { assert.equal(url, 'https://codeload.github.com/omnigent-ai/omnigent/tar.gz/refs/tags/v0.17.0'); return new Response('archive'); });
  assert.ok(updated.includes('FROM image:v0.17.0'));
  assert.ok(!updated.includes(zero));
});

test('HTTP failure fails closed', async () => {
  await assert.rejects(recapture('apps/codex/Containerfile', codex, async () => new Response('', { status: 404 })), /Download failed/);
});

test('privileged preparation rejects foreign PRs without reading files', async () => {
  const github = { rest: { pulls: { get: async () => ({ data: { user: { login: 'renovate[bot]' }, head: { repo: { full_name: 'attacker/repo' }, ref: 'renovate/codex-cli' } } }) } } };
  await assert.rejects(prepare({ github, context: { repo: { owner: 'igou-io', repo: 'igou-containers' }, payload: { pull_request: { number: 1 } } }, core: {} }), /Not an eligible/);
});

function fixture({ unchanged = false, racing = false, prepared = false, existingRun = false } = {}) {
  const calls = [];
  const pr = { number: 12, user: { login: 'renovate[bot]' }, head: { repo: { full_name: 'igou-io/igou-containers' }, ref: 'renovate/codex-cli', sha: 'head' }, base: { sha: 'base' } };
  let content = prepared ? codex.replaceAll(zero, sha) : codex;
  const github = {
    paginate: async method => method === github.rest.actions.listWorkflowRuns ?
      (existingRun ? [{ head_sha: pr.head.sha, status: 'in_progress' }] : []) :
      [{ filename: 'apps/codex/Containerfile', status: 'modified' }],
    rest: {
      pulls: { get: async () => ({ data: pr }), listFiles: () => {} },
      repos: { getContent: async ({ ref }) => ({ data: { content: Buffer.from(ref === 'base' && !unchanged ? codex.replace('0.157.1', '0.157.0') : content).toString('base64') } }) },
      git: {
        getRef: async () => ({ data: { object: { sha: racing ? 'changed' : pr.head.sha } } }),
        getCommit: async () => ({ data: { tree: { sha: 'old-tree' } } }),
        createTree: async options => { calls.push(['tree', options]); content = options.tree[0].content; return { data: { sha: 'new-tree' } }; },
        createCommit: async options => { calls.push(['commit', options]); return { data: { sha: 'new-head' } }; },
        updateRef: async options => { calls.push(['ref', options]); pr.head.sha = options.sha; },
      },
      actions: { listWorkflowRuns: () => {}, createWorkflowDispatch: async options => { calls.push(['dispatch', options]); } },
    },
  };
  return { calls, args: { github, context: { repo: { owner: 'igou-io', repo: 'igou-containers' }, payload: { pull_request: { number: 12 } } }, core: { info: () => {} } } };
}

test('checksum preparation commits an atomic patch and dispatches the build and review chain', async () => {
  const { calls, args } = fixture();
  await prepare(args, async () => new Response(manifest()));
  assert.deepEqual(calls.map(([name]) => name), ['tree', 'commit', 'ref', 'dispatch']);
  assert.ok(calls[0][1].tree[0].content.includes(sha));
  assert.equal(calls[2][1].force, false);
  assert.equal(calls[3][1].workflow_id, 'build-containers.yml');
  assert.deepEqual(calls[3][1].inputs, { app: 'codex' });
});

test('prepared checksums still dispatch missing checks', async () => {
  const { calls, args } = fixture({ prepared: true });
  await prepare(args, async () => new Response(manifest()));
  assert.deepEqual(calls.map(([name]) => name), ['dispatch']);
});

test('a dispatch failure after committing hashes recovers on rerun', async () => {
  const { calls, args } = fixture();
  const dispatch = args.github.rest.actions.createWorkflowDispatch;
  let fail = true;
  args.github.rest.actions.createWorkflowDispatch = async options => {
    if (fail) { fail = false; throw new Error('503 temporary failure'); }
    return dispatch(options);
  };
  await assert.rejects(prepare(args, async () => new Response(manifest())), /503/);
  await prepare(args, async () => new Response(manifest()));
  assert.deepEqual(calls.map(([name]) => name), ['tree', 'commit', 'ref', 'dispatch']);
});

test('an existing build is not dispatched twice', async () => {
  const { calls, args } = fixture({ prepared: true, existingRun: true });
  await prepare(args, async () => new Response(manifest()));
  assert.deepEqual(calls, []);
});

test('unchanged versions retain their trust pins and do not dispatch a build', async () => {
  const { calls, args } = fixture({ unchanged: true });
  await prepare(args, () => { throw new Error('Unchanged pins must not be recaptured'); });
  assert.deepEqual(calls, []);
});

test('a concurrent Renovate update is not overwritten', async () => {
  const { calls, args } = fixture({ racing: true });
  await assert.rejects(prepare(args, async () => new Response(manifest())), /PR changed/);
  assert.deepEqual(calls, []);
});
