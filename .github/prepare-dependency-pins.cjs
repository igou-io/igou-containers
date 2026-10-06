const { createHash } = require('node:crypto');

const definitions = {
  'apps/codex/Containerfile': { arg: 'CODEX_VERSION', pattern: /^\d+\.\d+\.\d+$/ },
  'apps/cursor-agent-cli/Containerfile': { arg: 'CURSOR_AGENT_VERSION', pattern: /^\d{4}\.\d{2}\.\d{2}-[a-f0-9]+$/ },
  'apps/omnigent-slack/Containerfile': { arg: 'OMNIGENT_VERSION', pattern: /^v\d+\.\d+\.\d+$/ },
};

function version(path, content) {
  const definition = definitions[path];
  const match = content.match(new RegExp(`^ARG ${definition.arg}="?([^"\\r\\n]+)"?$`, 'm'));
  if (!match || !definition.pattern.test(match[1])) throw new Error(`Invalid ${definition.arg}`);
  return match[1];
}

async function response(url, fetcher) {
  const result = await fetcher(url);
  if (!result.ok) throw new Error(`Download failed (${result.status}): ${url}`);
  return result;
}

async function digest(url, fetcher) {
  const hash = createHash('sha256');
  for await (const chunk of (await response(url, fetcher)).body) hash.update(chunk);
  return hash.digest('hex');
}

function replaceArg(content, arg, sha) {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error(`Invalid checksum for ${arg}`);
  const pattern = new RegExp(`^ARG ${arg}="[a-f0-9]{64}"$`, 'm');
  if (!pattern.test(content)) throw new Error(`Missing ${arg}`);
  return content.replace(pattern, `ARG ${arg}="${sha}"`);
}

async function recapture(path, content, fetcher = fetch) {
  const release = version(path, content);
  if (path === 'apps/codex/Containerfile') {
    const sums = await (await response(`https://github.com/openai/codex/releases/download/rust-v${release}/codex-package_SHA256SUMS`, fetcher)).text();
    for (const [arch, arg] of [['x86_64', 'CODEX_SHA256_X64'], ['aarch64', 'CODEX_SHA256_ARM64']]) {
      const asset = `codex-package-${arch}-unknown-linux-musl.tar.gz`;
      const matches = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(fields => fields[1]?.replace(/^\*/, '') === asset);
      if (matches.length !== 1) throw new Error(`Expected one checksum for ${asset}`);
      content = replaceArg(content, arg, matches[0][0]);
    }
  } else if (path === 'apps/cursor-agent-cli/Containerfile') {
    for (const [arch, arg] of [['x64', 'CURSOR_AGENT_SHA256_X64'], ['arm64', 'CURSOR_AGENT_SHA256_ARM64']]) {
      content = replaceArg(content, arg, await digest(`https://downloads.cursor.com/lab/${release}/linux/${arch}/agent-cli-package.tar.gz`, fetcher));
    }
  } else {
    const sha = await digest(`https://codeload.github.com/omnigent-ai/omnigent/tar.gz/refs/tags/${release}`, fetcher);
    const pattern = /ADD --checksum=sha256:[a-f0-9]{64}/;
    if (!pattern.test(content)) throw new Error('Missing Omnigent source checksum');
    content = content.replace(pattern, `ADD --checksum=sha256:${sha}`);
  }
  return content;
}

async function prepare({ github, context, core }, fetcher = fetch) {
  const { owner, repo } = context.repo;
  const pr = (await github.rest.pulls.get({ owner, repo, pull_number: context.payload.pull_request.number })).data;
  const branches = ['renovate/codex-cli', 'renovate/cursor-agent-cli', 'renovate/omnigent-slack-dependencies'];
  if (pr.user.login !== 'renovate[bot]' || pr.head.repo.full_name !== `${owner}/${repo}` || !branches.includes(pr.head.ref)) throw new Error('Not an eligible Renovate PR');
  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number });
  const changes = [];
  for (const file of files.filter(file => definitions[file.filename] && file.status === 'modified')) {
    const read = async ref => Buffer.from((await github.rest.repos.getContent({ owner, repo, path: file.filename, ref })).data.content, 'base64').toString('utf8');
    const head = await read(pr.head.sha);
    const base = await read(pr.base.sha);
    // Preserve existing trust pins unless the version actually changes.
    if (version(file.filename, head) === version(file.filename, base)) continue;
    const content = await recapture(file.filename, head, fetcher);
    if (content !== head) changes.push({ path: file.filename, mode: '100644', type: 'blob', content });
  }
  if (!changes.length) return core.info('Dependency checksums already prepared.');
  const current = (await github.rest.git.getRef({ owner, repo, ref: `heads/${pr.head.ref}` })).data.object.sha;
  if (current !== pr.head.sha) throw new Error('PR changed during checksum preparation; retry.');
  const tree = (await github.rest.git.createTree({ owner, repo, base_tree: (await github.rest.git.getCommit({ owner, repo, commit_sha: current })).data.tree.sha, tree: changes })).data;
  const commit = (await github.rest.git.createCommit({ owner, repo, message: 'chore(deps): refresh dependency checksums', tree: tree.sha, parents: [current], author: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' } })).data;
  await github.rest.git.updateRef({ owner, repo, ref: `heads/${pr.head.ref}`, sha: commit.sha, force: false });
  // GITHUB_TOKEN commits do not trigger pull_request workflows. Dispatch a
  // build explicitly so the new commit receives the required checks.
  await github.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: 'build-containers.yml', ref: pr.head.ref, inputs: { app: changes.map(file => file.path.split('/')[1]).join(' ') } });
  await github.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: 'dependency-review.yml', ref: pr.head.ref, inputs: { base: pr.base.sha, head: commit.sha } });
}

module.exports = { definitions, version, recapture, prepare };
