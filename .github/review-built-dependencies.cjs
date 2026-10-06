const fs = require('node:fs/promises');
const path = require('node:path');

const buildPath = '.github/workflows/build-containers.yml';
const defaultPlatforms = ['linux/amd64', 'linux/arm64'];

async function resolveRun({ github, context, core }, runId) {
  if (!/^[1-9]\d*$/.test(String(runId))) throw new Error('Invalid build run ID');
  const { owner, repo } = context.repo;
  const run = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(runId) })).data;
  if (run.path.split('@')[0] !== buildPath || run.repository.full_name !== `${owner}/${repo}` ||
      run.status !== 'completed' || !/^[a-f0-9]{40}$/.test(run.head_sha) ||
      !['pull_request', 'workflow_dispatch', 'push', 'schedule'].includes(run.event)) {
    throw new Error('Not a completed container build run');
  }
  const candidates = run.pull_requests?.length ? run.pull_requests :
    await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, { owner, repo, commit_sha: run.head_sha });
  const pulls = await Promise.all(candidates.map(pr => github.rest.pulls.get({ owner, repo, pull_number: pr.number }).then(result => result.data)));
  const defaultBranch = context.payload.repository.default_branch;
  const open = pulls.filter(pr => pr.state === 'open' && pr.base.repo.full_name === `${owner}/${repo}` && pr.base.ref === defaultBranch);
  const pr = open.find(pr => pr.head.sha === run.head_sha && pr.head.repo.full_name === run.head_repository.full_name);
  if (open.length && !pr) throw new Error('Build commit is no longer the PR head');
  if (!pr && (run.event === 'pull_request' || run.head_branch !== defaultBranch || run.head_repository.full_name !== `${owner}/${repo}`)) {
    core.info('No open PR for this build; no required review check will be created.');
    return null;
  }
  if (pr) {
    const check = (await github.rest.checks.create({ owner, repo, name: 'dependency-review', head_sha: run.head_sha, status: 'in_progress', details_url: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}` })).data;
    // Set this before validating artifacts so missing SBOMs report failure.
    core.setOutput('check', check.id);
  }
  if (run.conclusion !== 'success') throw new Error('Container build did not succeed');
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { owner, repo, run_id: run.id });
  let apps;
  if (pr) {
    const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number });
    apps = [...new Set(files.map(file => file.filename.match(/^apps\/([a-z0-9][a-z0-9-]*)\//)?.[1]).filter(Boolean))];
  } else {
    apps = artifacts.map(artifact => artifact.name.match(/^([a-z0-9][a-z0-9-]*)-sbom$/)?.[1]).filter(Boolean);
  }
  const read = async filename => {
    try {
      const result = await github.rest.repos.getContent({ owner, repo, path: filename, ref: run.head_sha });
      return Buffer.from(result.data.content, 'base64').toString('utf8');
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  };
  const expected = [];
  for (const app of apps) {
    if (await read(`apps/${app}/Containerfile`) === null) continue; // Retired image.
    const declared = await read(`apps/${app}/PLATFORMS`);
    const platforms = declared === null ? defaultPlatforms : declared.trim().split(',');
    if (!platforms.length || platforms.some(platform => !defaultPlatforms.includes(platform))) throw new Error(`Invalid platforms for ${app}`);
    if (!artifacts.some(artifact => artifact.name === `${app}-sbom` && !artifact.expired)) throw new Error(`Missing SBOM artifact for ${app}`);
    for (const platform of new Set(platforms)) expected.push({ app, arch: platform.split('/')[1] });
  }
  return { runId: run.id, head: run.head_sha, base: pr?.base.sha, pr: pr?.number, ref: pr ? `refs/pull/${pr.number}/head` : `refs/heads/${defaultBranch}`, expected };
}

function snapshotFor(snapshot, plan, { app, arch }) {
  if (snapshot.version !== 0 || !snapshot.detector?.version || !snapshot.manifests || typeof snapshot.manifests !== 'object') throw new Error('Invalid Syft GitHub SBOM');
  // Syft links use original keys and can cross source manifests.
  const resolved = {}, keys = {};
  for (const manifest of Object.values(snapshot.manifests)) {
    if (manifest.resolved != null && (typeof manifest.resolved !== 'object' || Array.isArray(manifest.resolved))) throw new Error('Invalid resolved SBOM packages');
    for (const [key, dependency] of Object.entries(manifest.resolved || {})) keys[key] = dependency.package_url;
  }
  for (const manifest of Object.values(snapshot.manifests)) {
    for (const dependency of Object.values(manifest.resolved || {})) {
      if (typeof dependency.package_url !== 'string' || !/^pkg:[a-z][a-z0-9.-]*\//.test(dependency.package_url)) throw new Error('Invalid SBOM package URL');
      if (dependency.dependencies != null && (!Array.isArray(dependency.dependencies) || dependency.dependencies.some(key => !keys[key]))) throw new Error('Invalid SBOM dependency reference');
      resolved[dependency.package_url] = { ...dependency, scope: dependency.scope || 'runtime', ...(dependency.dependencies ? { dependencies: [...new Set(dependency.dependencies.map(key => keys[key]))] } : {}) };
    }
  }
  if (!Object.keys(resolved).length) throw new Error(`Empty SBOM for ${app}/${arch}`);
  const name = `apps/${app}/${arch}.image`;
  return {
    version: 0, sha: plan.head, ref: plan.ref, scanned: new Date().toISOString(),
    detector: { name: 'syft', version: snapshot.detector.version, url: 'https://github.com/anchore/syft' },
    job: { id: `${plan.runId}-${app}-${arch}`, correlator: `container-image-${app}-${arch}` },
    manifests: { [name]: { name, file: { source_location: `apps/${app}/Containerfile` }, resolved } },
  };
}

async function publishSnapshots({ github, context, core }, plan, directory) {
  // Validate every architecture before publishing any snapshots. No artifact
  // code or commands execute in this privileged workflow.
  const snapshots = await Promise.all(plan.expected.map(async image => {
    const filename = path.join(directory, `${image.app}-sbom`, `${image.arch}.github.json`);
    return snapshotFor(JSON.parse(await fs.readFile(filename, 'utf8')), plan, image);
  }));
  for (const snapshot of snapshots) {
    await github.rest.dependencyGraph.createRepositorySnapshot({ ...context.repo, ...snapshot });
    core.info(`Submitted ${snapshot.job.correlator} for ${plan.head}`);
  }
}

async function finishCheck({ github, context }, checkId, status) {
  if (!checkId) return;
  await github.rest.checks.update({ ...context.repo, check_run_id: Number(checkId), status: 'completed', conclusion: status === 'success' ? 'success' : status === 'cancelled' ? 'cancelled' : 'failure' });
}

module.exports = { resolveRun, snapshotFor, publishSnapshots, finishCheck };
