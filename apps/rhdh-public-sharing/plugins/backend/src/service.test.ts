import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigReader } from '@backstage/config';
import type { UrlReaderService } from '@backstage/backend-plugin-api';
import { SharingService } from './service';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => 'test-file-value') }));

function setup() {
  const config = new ConfigReader({
    app: { baseUrl: 'https://rhdh.example.com' },
    backend: { baseUrl: 'https://rhdh.example.com' },
    publicSharing: {
      catalogUrl: 'https://github.com/example/inventory/blob/main/public_sharing.yml',
      aap: {
        baseUrl: 'https://aap.example.com',
        clientId: 'test-client',
        clientSecret: 'test-secret',
      },
      clusters: Object.fromEntries(
        ['ocp', 'vps'].map((c) => [
          c,
          { server: `https://${c}.example.com`, tokenFile: '/test/token', caFile: '/test/ca' },
        ])
      ),
    },
  });
  const reader = {
    readUrl: vi.fn(async () => ({
      buffer: async () =>
        Buffer.from(`public_share_backends:
  web:
    service: web-public
    tailnet_fqdn: ocp-public-web.example.ts.net
    ports:
      HTTP: 8080
`),
    })),
  } as unknown as UrlReaderService;
  const request = vi.fn(async (url: string, opts?: any): Promise<any> => {
    const path = new URL(url).pathname;
    if (path === '/o/token/')
      return {
        access_token: 'test-user-access',
        refresh_token: 'test-user-refresh',
        expires_in: 3600,
      };
    if (path === '/o/revoke_token/') return undefined;
    if (path === '/api/controller/v2/me/') return { results: [{ id: 7, username: 'caller' }] };
    if (path === '/api/controller/v2/job_templates/')
      return {
        results: [
          {
            id: 120,
            name: 'vps_public_share',
            survey_enabled: true,
            ask_variables_on_launch: false,
            allow_simultaneous: false,
            summary_fields: { user_capabilities: { start: true } },
          },
        ],
      };
    if (path.endsWith('/launch/')) return { id: 123, ignored_fields: {}, echoed: opts?.body };
    if (path.endsWith('/gateways/public'))
      return {
        kind: 'Gateway',
        metadata: { name: 'public', generation: 1 },
        spec: { listeners: [{ name: 'https', protocol: 'HTTPS', port: 443 }] },
        status: {
          conditions: ['Accepted', 'Programmed'].map((type) => ({
            type,
            status: 'True',
            observedGeneration: 1,
          })),
        },
      };
    if (url.startsWith('https://ocp.') && path.endsWith('/services'))
      return {
        kind: 'ServiceList',
        items: [
          {
            metadata: {
              name: 'web-public',
              annotations: { 'tailscale.com/hostname': 'ocp-public-web' },
            },
            spec: {
              type: 'LoadBalancer',
              loadBalancerClass: 'tailscale',
              selector: { app: 'web' },
              ports: [{ port: 8080 }],
            },
          },
        ],
      };
    if (url.startsWith('https://ocp.') && path.endsWith('/endpointslices'))
      return {
        kind: 'EndpointSliceList',
        items: [
          {
            metadata: { name: 'web', labels: { 'kubernetes.io/service-name': 'web-public' } },
            endpoints: [{ conditions: { ready: true } }],
          },
        ],
      };
    if (path.endsWith('/jobs/123/'))
      return {
        id: 123,
        status: 'successful',
        artifacts: { public_share_created_id: 'ps-123', secret: 'do-not-return' },
      };
    return { kind: 'ServiceList', items: [] };
  });
  const service = new SharingService(config, reader, request);
  const connect = async (user = 'user:default/caller') => {
    const url = new URL(service.start(user));
    await service.callback(url.searchParams.get('state')!, 'test-code');
    return url;
  };
  return { service, request, connect, reader };
}

describe('per-user AAP execution and live reads', () => {
  beforeEach(() => vi.clearAllMocks());
  it('does not query clusters before the caller connects AAP', async () => {
    const { service, request } = setup();
    expect(await service.state('user:default/other')).toEqual({ connected: false });
    expect(request).not.toHaveBeenCalled();
  });
  it('uses PKCE and consumes OAuth state exactly once', async () => {
    const { service, connect } = setup();
    const url = await connect();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(service.callback(url.searchParams.get('state')!, 'test-code')).rejects.toThrow(
      'expired'
    );
    expect(await service.state('user:default/other')).toEqual({ connected: false });
  });
  it('uses the controller user identity and never returns OAuth credentials', async () => {
    const { service, connect, request } = setup();
    await connect();
    const state = await service.state('user:default/caller');
    expect(state).toMatchObject({
      connected: true,
      username: 'caller',
      backends: [{ name: 'web', ready: true }],
    });
    expect(JSON.stringify(state)).not.toContain('test-user-access');
    expect(request.mock.calls.some(([url]) => url.includes('/api/controller/v2/me/'))).toBe(true);
  });
  it('launches only the fixed template with the user token and allowlisted survey inputs', async () => {
    const { service, request, connect } = setup();
    await connect();
    expect(
      await service.launch('user:default/caller', {
        action: 'create',
        backend: 'web',
        protocol: 'HTTP',
        leaseHours: 2,
        job_template: 1,
        awx_user_id: 1,
      })
    ).toMatchObject({ id: 123 });
    const call = request.mock.calls.find(([url]) => url.endsWith('/120/launch/'))!;
    expect(call[1].token).toBe('test-user-access');
    expect(call[1].body.extra_vars).toMatchObject({
      public_share_action: 'create',
      public_share_backend: 'web',
    });
    expect(call[1].body.extra_vars).not.toHaveProperty('awx_user_id');
    expect(await service.job('user:default/caller', 123)).toMatchObject({
      status: 'successful',
      shareId: 'ps-123',
    });
    expect(await service.job('user:default/caller', 123)).not.toHaveProperty('secret');
    await expect(service.job('user:default/caller', 999)).rejects.toThrow('not launched');
  });
  it('fails closed if live state cannot be read, without launching automation', async () => {
    const { service, request, connect, reader } = setup();
    await connect();
    vi.mocked(reader.readUrl).mockRejectedValueOnce(new Error('catalog unavailable'));
    await expect(
      service.launch('user:default/caller', {
        action: 'create',
        backend: 'web',
        protocol: 'HTTP',
        leaseHours: 2,
      })
    ).rejects.toThrow('catalog unavailable');
    expect(request.mock.calls.filter(([url]) => url.endsWith('/launch/'))).toHaveLength(0);
  });
  it('rechecks AAP execute permission on every refresh', async () => {
    const { service, request, connect } = setup();
    await connect();
    request.mockImplementationOnce(async () => ({ results: [] }));
    await expect(service.state('user:default/caller')).rejects.toThrow('execute permission');
  });
  it('removes the local session on disconnect', async () => {
    const { service, connect } = setup();
    await connect();
    await service.disconnect('user:default/caller');
    expect(await service.state('user:default/caller')).toEqual({ connected: false });
  });
});
