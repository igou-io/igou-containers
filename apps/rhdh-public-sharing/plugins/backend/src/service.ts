import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import type { UrlReaderService } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import { AuthenticationError, InputError, NotAllowedError } from '@backstage/errors';
import { parse } from 'yaml';
import { requestJson } from './http';
import { launchVariables, parseCatalog, snapshot, type KubeObject } from './model';

type Session = {
  accessToken: string;
  refreshToken?: string;
  expires: number;
  deadline: number;
  userId: number;
  username: string;
  jobs: Set<number>;
  refreshing?: Promise<void>;
};
type Pending = { user: string; verifier: string; expires: number };
type FetchJson = typeof requestJson;

export class SharingService {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Pending>();
  private readonly aap: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  readonly appOrigin: string;
  readonly redirectUri: string;

  constructor(
    private readonly config: Config,
    private readonly reader: UrlReaderService,
    private readonly request: FetchJson = requestJson
  ) {
    this.aap = config.getString('publicSharing.aap.baseUrl').replace(/\/$/, '');
    this.clientId = config.getString('publicSharing.aap.clientId');
    this.clientSecret = config.getString('publicSharing.aap.clientSecret');
    this.appOrigin = new URL(config.getString('app.baseUrl')).origin;
    this.redirectUri = `${config
      .getString('backend.baseUrl')
      .replace(/\/$/, '')}/api/public-sharing/oauth/callback`;
    for (const url of [this.aap, this.appOrigin, this.redirectUri]) {
      if (new URL(url).protocol !== 'https:') throw new Error('Sharing OAuth requires HTTPS');
    }
  }

  private prune() {
    const now = Date.now();
    for (const [key, p] of this.pending) if (p.expires <= now) this.pending.delete(key);
    for (const [key, s] of this.sessions) if (s.deadline <= now) this.sessions.delete(key);
  }

  start(user: string) {
    this.prune();
    for (const [key, p] of this.pending) if (p.user === user) this.pending.delete(key);
    if (this.pending.size >= 1000 || (!this.sessions.has(user) && this.sessions.size >= 1000))
      throw new Error('Connection capacity reached');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.pending.set(state, { user, verifier, expires: Date.now() + 300000 });
    const url = new URL('/o/authorize/', this.aap);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: 'write',
      state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    return url.toString();
  }

  async callback(state: string, code: string) {
    this.prune();
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || !code) throw new AuthenticationError('OAuth request expired; connect again');
    const data = await this.request(`${this.aap}/o/token/`, {
      method: 'POST',
      basic: `${this.clientId}:${this.clientSecret}`,
      form: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        code_verifier: pending.verifier,
      }),
    });
    const session = await this.makeSession(data);
    // This also prevents connecting a caller who cannot execute the sharing template.
    await this.template(session);
    this.sessions.set(pending.user, session);
  }

  private async makeSession(data: any): Promise<Session> {
    if (
      !data.access_token ||
      !Number.isFinite(Number(data.expires_in)) ||
      Number(data.expires_in) <= 0
    ) {
      throw new AuthenticationError('AAP did not issue a valid session');
    }
    // awx_user_id is the controller identity, which may differ from the gateway ID.
    const me = await this.request(`${this.aap}/api/controller/v2/me/`, {
      token: data.access_token,
    });
    const user = me.results?.[0];
    if (!Number.isInteger(user?.id) || typeof user?.username !== 'string')
      throw new AuthenticationError('AAP identity is unavailable');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expires: Date.now() + Number(data.expires_in) * 1000,
      deadline: Date.now() + 8 * 3600000,
      userId: user.id,
      username: user.username,
      jobs: new Set(),
    };
  }

  private async session(user: string) {
    this.prune();
    const s = this.sessions.get(user);
    if (!s) throw new AuthenticationError('Connect your AAP account');
    if (s.expires <= Date.now() + 30000) {
      if (!s.refreshToken) {
        this.sessions.delete(user);
        throw new AuthenticationError('Reconnect your AAP account');
      }
      if (!s.refreshing) {
        s.refreshing = (async () => {
          const data = await this.request(`${this.aap}/o/token/`, {
            method: 'POST',
            basic: `${this.clientId}:${this.clientSecret}`,
            form: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: s.refreshToken!,
            }),
          });
          const refreshed = await this.makeSession(data);
          if (refreshed.userId !== s.userId) throw new AuthenticationError('AAP identity changed');
          s.accessToken = refreshed.accessToken;
          s.refreshToken = refreshed.refreshToken;
          s.expires = refreshed.expires;
        })()
          .catch(() => {
            this.sessions.delete(user);
            throw new AuthenticationError('Reconnect your AAP account');
          })
          .finally(() => {
            s.refreshing = undefined;
          });
      }
      await s.refreshing;
    }
    return s;
  }

  async disconnect(user: string) {
    const s = this.sessions.get(user);
    this.sessions.delete(user);
    for (const [key, p] of this.pending) if (p.user === user) this.pending.delete(key);
    if (s) {
      await Promise.all(
        [...new Set([s.accessToken, s.refreshToken].filter((t): t is string => Boolean(t)))].map(
          (token) =>
            this.request(`${this.aap}/o/revoke_token/`, {
              method: 'POST',
              basic: `${this.clientId}:${this.clientSecret}`,
              form: new URLSearchParams({ token }),
            })
        )
      );
    }
  }

  private async template(s: Session) {
    const name =
      this.config.getOptionalString('publicSharing.aap.templateName') ?? 'vps_public_share';
    const data = await this.request(
      `${this.aap}/api/controller/v2/job_templates/?name=${encodeURIComponent(name)}`,
      { token: s.accessToken }
    );
    const jt = data.results?.find((t: any) => t.name === name);
    if (!jt || jt.summary_fields?.user_capabilities?.start !== true)
      throw new NotAllowedError('AAP execute permission is required for public sharing');
    if (!jt.survey_enabled || jt.ask_variables_on_launch || jt.allow_simultaneous)
      throw new Error('Sharing template guardrails differ from the expected configuration');
    return jt.id as number;
  }

  private async kube(cluster: 'ocp' | 'vps', path: string) {
    const prefix = `publicSharing.clusters.${cluster}`;
    const [token, ca] = await Promise.all([
      readFile(this.config.getString(`${prefix}.tokenFile`), 'utf8'),
      readFile(this.config.getString(`${prefix}.caFile`), 'utf8'),
    ]);
    const base = this.config.getString(`${prefix}.server`).replace(/\/$/, '');
    let next = `${base}${path}${path.includes('?') ? '&' : '?'}limit=500`;
    let items: KubeObject[] = [];
    for (let page = 0; page < 20; page++) {
      const data = await this.request(next, { token: token.trim(), ca });
      if (!Array.isArray(data.items)) return data;
      // Kubernetes List.items may omit kind even when the list itself has a kind.
      const kind = String(data.kind ?? '').replace(/List$/, '');
      items = items.concat(data.items.map((o: KubeObject) => ({ ...o, kind: o.kind ?? kind })));
      if (!data.metadata?.continue) return items;
      next = `${base}${path}${
        path.includes('?') ? '&' : '?'
      }limit=500&continue=${encodeURIComponent(data.metadata.continue)}`;
    }
    throw new Error('Runtime resource listing exceeded its limit');
  }

  private async runtime(s: Session) {
    const catalogUrl = this.config.getString('publicSharing.catalogUrl');
    const catalog = parseCatalog(
      parse((await (await this.reader.readUrl(catalogUrl)).buffer()).toString('utf8'))
    );
    const api = '/apis/gateway.networking.k8s.io/v1';
    const paths = [
      '/api/v1/namespaces/public-services/services',
      '/api/v1/namespaces/tailscale/services',
      ...['httproutes', 'tcproutes', 'udproutes'].map(
        (k) => `${api}/namespaces/public-services/${k}`
      ),
      '/apis/gateway.networking.k8s.io/v1beta1/namespaces/tailscale/referencegrants',
      '/apis/networking.k8s.io/v1/namespaces/tailscale/networkpolicies',
    ];
    const [services, endpoints, gateway, proxyEndpoints, objects] = await Promise.all([
      this.kube('ocp', '/api/v1/namespaces/public-services/services'),
      this.kube('ocp', '/apis/discovery.k8s.io/v1/namespaces/public-services/endpointslices'),
      this.kube('vps', `${api}/namespaces/nginx-gateway/gateways/public`),
      this.kube('vps', '/apis/discovery.k8s.io/v1/namespaces/tailscale/endpointslices'),
      Promise.all(paths.map((p) => this.kube('vps', p))),
    ]);
    return snapshot({
      catalog,
      services,
      endpoints,
      gateway,
      proxyEndpoints,
      objects: objects.flat(),
      userId: s.userId,
    });
  }

  async state(user: string) {
    this.prune();
    if (!this.sessions.has(user)) return { connected: false as const };
    const s = await this.session(user);
    await this.template(s);
    return { connected: true as const, username: s.username, ...(await this.runtime(s)) };
  }

  async launch(user: string, input: unknown) {
    const s = await this.session(user);
    const templateId = await this.template(s);
    // Always read again on submit; the browser's snapshot never authorizes an action.
    const state = await this.runtime(s);
    let variables;
    try {
      variables = launchVariables(input, state);
    } catch (e) {
      if (e instanceof Error) throw new InputError(e.message);
      throw e;
    }
    const job = await this.request(
      `${this.aap}/api/controller/v2/job_templates/${templateId}/launch/`,
      {
        token: s.accessToken,
        method: 'POST',
        body: { extra_vars: variables },
      }
    );
    if (Object.keys(job.ignored_fields ?? {}).length || !Number.isInteger(job.id)) {
      throw new Error('AAP did not accept the sharing inputs; inspect the AAP job before retrying');
    }
    s.jobs.add(job.id);
    // Bound process memory for a long-running browser session.
    if (s.jobs.size > 100) s.jobs.delete(s.jobs.values().next().value!);
    return { id: job.id, url: `${this.aap}/execution/jobs/playbook/${job.id}/details` };
  }

  async job(user: string, id: number) {
    const s = await this.session(user);
    if (!s.jobs.has(id)) throw new NotAllowedError('Job was not launched in this session');
    const job = await this.request(`${this.aap}/api/controller/v2/jobs/${id}/`, {
      token: s.accessToken,
    });
    return {
      id: job.id,
      status: job.status,
      finished: job.finished,
      shareId: job.artifacts?.public_share_created_id ?? '',
      url: `${this.aap}/execution/jobs/playbook/${job.id}/details`,
    };
  }
}
