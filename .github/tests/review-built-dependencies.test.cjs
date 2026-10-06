const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveRun, snapshotFor, publishSnapshots, finishCheck } = require('../review-built-dependencies.cjs');
const head = 'a'.repeat(40), base = 'b'.repeat(40);

function fixture() {
  const calls = [], outputs = {};
  const run = { id: 123, path: '.github/workflows/build-containers.yml', repository: { full_name: 'igou-io/igou-containers' }, head_repository: { full_name: 'igou-io/igou-containers' }, head_branch: 'renovate/codex-cli', head_sha: head, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', pull_requests: [{ number: 12 }] };
  const pr = { number: 12, state: 'open', head: { sha: head, repo: { full_name: 'igou-io/igou-containers' } }, base: { sha: base, ref: 'main', repo: { full_name: 'igou-io/igou-containers' } } };
  const artifacts = [{ name: 'codex-sbom', expired: false }];
  const files = [{ filename: 'apps/codex/Containerfile' }];
  const github = {
    paginate: async method => method === github.rest.actions.listWorkflowRunArtifacts ? artifacts : method === github.rest.pulls.listFiles ? files : [{ number: 12 }],
    rest: {
      actions: { getWorkflowRun: async () => ({ data: run }), listWorkflowRunArtifacts() {} },
      pulls: { get: async () => ({ data: pr }), listFiles() {} },
      repos: { listPullRequestsAssociatedWithCommit() {}, getContent: async ({ path: filename, ref }) => {
        assert.equal(ref, head);
        if (filename.endsWith('PLATFORMS')) throw Object.assign(new Error('404'), { status: 404 });
        return { data: { content: Buffer.from('FROM image').toString('base64') } };
      } },
      checks: { create: async options => { calls.push(['check', options]); return { data: { id: 456 } }; }, update: async options => { calls.push(['finish', options]); } },
      dependencyGraph: { createRepositorySnapshot: async options => { calls.push(['snapshot', options]); } },
    },
  };
  const context = { repo: { owner: 'igou-io', repo: 'igou-containers' }, payload: { repository: { default_branch: 'main' } }, serverUrl: 'https://github.com', runId: 789 };
  const core = { setOutput: (name, value) => { outputs[name] = value; }, info() {} };
  return { args: { github, context, core }, run, pr, artifacts, files, calls, outputs };
}

function sbom() {
  return { version: 0, detector: { version: '1.54.0' }, sha: 'untrusted', ref: 'untrusted', job: { correlator: 'untrusted' }, manifests: { first: { resolved: { package: { package_url: 'pkg:golang/example.com/tool@1.2.3', scope: 'runtime', relationship: 'direct' } } }, empty: {} } };
}

test('review derives comparison refs and creates the required check on the actual built PR head', async () => {
  const { args, outputs, calls } = fixture();
  const plan = await resolveRun(args, '123');
  assert.deepEqual(plan, { runId: 123, head, base, pr: 12, ref: 'refs/pull/12/head', expected: [{ app: 'codex', arch: 'amd64' }, { app: 'codex', arch: 'arm64' }] });
  assert.equal(outputs.check, 456);
  assert.equal(calls[0][1].name, 'dependency-review');
  assert.equal(calls[0][1].head_sha, head);
});

test('a branch advancing after dispatch cannot receive a passing check for an older comparison', async () => {
  const { args, pr, calls } = fixture();
  pr.head.sha = 'c'.repeat(40);
  await assert.rejects(resolveRun(args, 123), /no longer the PR head/);
  assert.deepEqual(calls, []);
});

test('rejects unrelated workflows, incomplete runs, and invalid run IDs before creating checks', async () => {
  for (const patch of [{ path: '.github/workflows/other.yml' }, { status: 'in_progress' }, { repository: { full_name: 'attacker/repo' } }, { head_sha: '../other' }]) {
    const { args, run, calls } = fixture();
    Object.assign(run, patch);
    await assert.rejects(resolveRun(args, 123), /Not a completed/);
    assert.deepEqual(calls, []);
  }
  await assert.rejects(resolveRun(fixture().args, '123;echo'), /Invalid build run/);
});

test('fork PR artifacts can be reviewed without checking out fork code', async () => {
  const { args, run, pr } = fixture();
  run.head_repository.full_name = 'contributor/igou-containers';
  pr.head.repo.full_name = run.head_repository.full_name;
  run.event = 'pull_request';
  assert.equal((await resolveRun(args, 123)).pr, 12);
});

test('manual runs find their associated PR even when the run contains no PR metadata', async () => {
  const { args, run } = fixture();
  run.pull_requests = [];
  assert.equal((await resolveRun(args, 123)).pr, 12);
});

test('non-PR branch runs cannot create a successful required review check', async () => {
  const { args, pr, calls } = fixture();
  pr.state = 'closed';
  assert.equal(await resolveRun(args, 123), null);
  assert.deepEqual(calls, []);
});

test('failed builds and missing SBOM artifacts leave a check that can be finalized as failure', async () => {
  for (const failure of ['build', 'artifact']) {
    const { args, run, artifacts, outputs, calls } = fixture();
    if (failure === 'build') run.conclusion = 'failure'; else artifacts.length = 0;
    await assert.rejects(resolveRun(args, 123), failure === 'build' ? /did not succeed/ : /Missing SBOM/);
    await finishCheck(args, outputs.check, 'failure');
    assert.equal(calls.at(-1)[1].conclusion, 'failure');
    assert.ok(!calls.some(([type]) => type === 'snapshot'));
  }
});

test('retired apps need no artifact while single-platform images require only their declared architecture', async () => {
  const { args, files, artifacts } = fixture();
  files.push({ filename: 'apps/mcpo/Containerfile' }, { filename: 'apps/zfs-exporter/Containerfile' });
  artifacts.push({ name: 'zfs-exporter-sbom' });
  args.github.rest.repos.getContent = async ({ path: filename }) => {
    if (filename.startsWith('apps/mcpo') || (filename.endsWith('PLATFORMS') && !filename.includes('zfs-exporter'))) throw Object.assign(new Error('404'), { status: 404 });
    return { data: { content: Buffer.from(filename.endsWith('PLATFORMS') ? 'linux/amd64' : 'FROM image').toString('base64') } };
  };
  assert.equal((await resolveRun(args, 123)).expected.filter(image => image.app === 'zfs-exporter').length, 1);
});

test('default branch builds publish snapshots without approving any PR', async () => {
  const { args, pr, run, calls } = fixture();
  pr.state = 'closed'; run.head_branch = 'main'; run.event = 'push';
  const plan = await resolveRun(args, 123);
  assert.equal(plan.pr, undefined);
  assert.equal(plan.ref, 'refs/heads/main');
  assert.deepEqual(calls, []);
});

test('snapshot metadata is bound to the validated SHA and stable per-image/per-architecture identities', () => {
  const plan = { runId: 123, head, ref: 'refs/pull/12/head' };
  const image = { app: 'codex', arch: 'arm64' };
  const result = snapshotFor(sbom(), plan, image);
  assert.equal(result.sha, head); assert.equal(result.ref, plan.ref);
  assert.equal(result.job.correlator, 'container-image-codex-arm64');
  assert.equal(result.manifests['apps/codex/arm64.image'].file.source_location, 'apps/codex/Containerfile');
  const baseline = snapshotFor(sbom(), { ...plan, ref: 'refs/heads/main', head: base }, image);
  assert.equal(baseline.job.correlator, result.job.correlator);
});

test('empty SBOMs and malformed package URLs fail closed', () => {
  const plan = { runId: 123, head, ref: 'refs/pull/12/head' }, image = { app: 'codex', arch: 'amd64' };
  const empty = sbom(); empty.manifests = {};
  assert.throws(() => snapshotFor(empty, plan, image), /Empty SBOM/);
  const malformed = sbom(); malformed.manifests.first.resolved.package.package_url = 'https://example.invalid';
  assert.throws(() => snapshotFor(malformed, plan, image), /Invalid SBOM package URL/);
});

test('all expected architectures are validated before submitting any snapshots', async t => {
  const { args, calls } = fixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'igou-sbom-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'codex-sbom'));
  await fs.writeFile(path.join(directory, 'codex-sbom', 'amd64.github.json'), JSON.stringify(sbom()));
  const plan = { runId: 123, head, ref: 'refs/pull/12/head', expected: [{ app: 'codex', arch: 'amd64' }, { app: 'codex', arch: 'arm64' }] };
  await assert.rejects(publishSnapshots(args, plan, directory), /ENOENT/);
  assert.deepEqual(calls, []);
  await fs.writeFile(path.join(directory, 'codex-sbom', 'arm64.github.json'), JSON.stringify(sbom()));
  await publishSnapshots(args, plan, directory);
  assert.deepEqual(calls.map(([type]) => type), ['snapshot', 'snapshot']);
  assert.ok(calls.every(([, snapshot]) => snapshot.sha === head));
});

test('failed and cancelled review jobs never finalize the required check as success', async () => {
  const { args, calls } = fixture();
  await finishCheck(args, 456, 'failure');
  await finishCheck(args, 456, 'cancelled');
  assert.deepEqual(calls.map(([, check]) => check.conclusion), ['failure', 'cancelled']);
});
