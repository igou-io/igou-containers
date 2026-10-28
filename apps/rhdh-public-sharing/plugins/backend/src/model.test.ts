import { describe, expect, it } from 'vitest';
import {
  ID,
  OWNER,
  EXPIRY,
  launchVariables,
  parseCatalog,
  snapshot,
  type KubeObject,
} from './model';

export const now = new Date('2026-10-28T15:00:00Z');
export function fixture() {
  return {
    catalog: parseCatalog({
      public_share_backends: {
        web: {
          service: 'web-public',
          tailnet_fqdn: 'ocp-public-web.example.ts.net',
          ports: { HTTP: 8080 },
        },
        game: {
          service: 'game-public',
          tailnet_fqdn: 'ocp-public-game.example.ts.net',
          ports: { UDP: 27020 },
        },
      },
    }),
    userId: 7,
    services: ['web', 'game'].map((name, i) => ({
      kind: 'Service',
      metadata: {
        name: `${name}-public`,
        annotations: { 'tailscale.com/hostname': `ocp-public-${name}` },
      },
      spec: {
        type: 'LoadBalancer',
        loadBalancerClass: 'tailscale',
        selector: { app: name },
        ports: [{ port: i ? 27020 : 8080, protocol: i ? 'UDP' : 'TCP' }],
      },
    })),
    endpoints: ['web', 'game'].map((name) => ({
      kind: 'EndpointSlice',
      metadata: { name, labels: { 'kubernetes.io/service-name': `${name}-public` } },
      endpoints: [{ conditions: { ready: true } }],
    })),
    objects: [] as KubeObject[],
    proxyEndpoints: [] as KubeObject[],
    gateway: {
      kind: 'Gateway',
      metadata: { name: 'public', generation: 1 },
      spec: {
        listeners: [
          { name: 'https', protocol: 'HTTPS', port: 443 },
          { name: 'tcp-27010', protocol: 'TCP', port: 27010 },
          { name: 'udp-27018', protocol: 'UDP', port: 27018 },
          { name: 'udp-27019', protocol: 'UDP', port: 27019 },
        ],
      },
      status: {
        conditions: ['Accepted', 'Programmed'].map((type) => ({
          type,
          status: 'True',
          observedGeneration: 1,
        })),
      },
    },
  };
}
export function resource(id = 'ps-123', owner = 'aap-user-7', kind = 'UDPRoute'): KubeObject {
  return {
    kind,
    metadata: {
      name: `${id}-udp`,
      namespace: 'public-services',
      generation: 1,
      labels: { [ID]: id, 'app.kubernetes.io/managed-by': 'public-share-aap' },
      annotations: { [OWNER]: owner, [EXPIRY]: '2026-10-28T17:00:00Z' },
    },
    spec: {
      parentRefs: [{ name: 'public', namespace: 'nginx-gateway', sectionName: 'udp-27018' }],
    },
  };
}

describe('runtime sharing menu', () => {
  it('shows approved backends but disables zero-endpoint workloads', () => {
    const data = fixture();
    data.endpoints = [];
    expect(snapshot(data, now).backends.every((b) => !b.ready)).toBe(true);
  });
  it('does not accept a hostname replacement or mismatched backend port', () => {
    const data = fixture();
    data.services[0].spec.ports[0].port = 9999;
    data.services[1].metadata.annotations['tailscale.com/hostname'] = 'wrong';
    expect(snapshot(data, now).backends.every((b) => !b.ready)).toBe(true);
  });
  it('counts all owners against quota but only exposes the caller’s shares', () => {
    const data = fixture();
    data.objects = [resource(), resource('ps-456', 'aap-user-8')];
    const state = snapshot(data, now);
    expect(state.shares.map((s) => s.id)).toEqual(['ps-123']);
    expect(state.limits.active).toBe(2);
    expect(state.limits.ownActive).toBe(1);
    expect(state.freePorts.UDP).toEqual([27019]);
  });
  it('reserves ports taken by unmanaged or wildcard routes', () => {
    const data = fixture();
    const r = resource();
    r.metadata.labels = {};
    r.spec.parentRefs[0].sectionName = undefined;
    data.objects = [r];
    expect(snapshot(data, now).freePorts.UDP).toEqual([]);
  });
  it('honors Gateway attached routes even if the route is outside the listing', () => {
    const data = fixture();
    (data.gateway.status as any).listeners = [{ name: 'tcp-27010', attachedRoutes: 1 }];
    expect(snapshot(data, now).freePorts.TCP).toEqual([]);
  });
  it('includes expired and incomplete objects until cleanup removes them', () => {
    const data = fixture();
    const r = resource('ps-123', 'aap-user-7', 'Service');
    r.metadata.annotations![EXPIRY] = '2026-10-28T14:00:00Z';
    data.objects = [r];
    const state = snapshot(data, now);
    expect(state.shares[0].status).toBe('Awaiting cleanup');
    expect(state.limits.active).toBe(1);
  });
  it('requires current-generation Gateway status', () => {
    const data = fixture();
    data.gateway.metadata.generation = 2;
    expect(snapshot(data, now).gatewayReady).toBe(false);
    expect(snapshot(data, now).freePorts.UDP).toEqual([]);
  });
  it('does not claim a route is configured without a ready proxy', () => {
    const data = fixture();
    const r = resource();
    r.status = {
      parents: [
        {
          parentRef: { name: 'public', namespace: 'nginx-gateway' },
          conditions: ['Accepted', 'ResolvedRefs'].map((type) => ({
            type,
            status: 'True',
            observedGeneration: 1,
          })),
        },
      ],
    };
    data.objects = [r];
    expect(snapshot(data, now).shares[0].status).toBe('Provisioning or incomplete');
    data.proxyEndpoints = [
      {
        kind: 'EndpointSlice',
        metadata: { name: 'proxy', labels: { 'kubernetes.io/service-name': 'ocp-ps-123-bridge' } },
        endpoints: [{ conditions: { ready: true } }],
      },
    ];
    expect(snapshot(data, now).shares[0].status).toBe('Configured');
  });
});

describe('submit-time validation', () => {
  const body = { action: 'create', backend: 'game', protocol: 'UDP', port: 27018, leaseHours: 2 };
  it('emits only the survey allowlist with server-computed expiration', () => {
    expect(
      launchVariables(
        { ...body, awx_user_id: 1, extra_vars: { evil: true } },
        snapshot(fixture(), now),
        now
      )
    ).toEqual({
      public_share_action: 'create',
      public_share_backend: 'game',
      public_share_protocols: ['UDP'],
      public_share_udp_port: 27018,
      public_share_expires_at: '2026-10-28T17:00:00Z',
    });
  });
  it('rejects a port which was occupied after the menu was rendered', () => {
    const data = fixture();
    data.objects = [resource()];
    expect(() => launchVariables(body, snapshot(data, now), now)).toThrow('no longer available');
  });
  it('sends whole-second UTC timestamps when the server clock includes milliseconds', () => {
    const variables = launchVariables(
      body,
      snapshot(fixture(), now),
      new Date('2026-10-28T15:00:00.157Z')
    );
    expect(variables.public_share_expires_at).toBe('2026-10-28T17:00:00Z');
  });
  it('rejects offline services, unsupported protocols, and excess leases', () => {
    const data = fixture();
    data.endpoints = [];
    expect(() => launchVariables(body, snapshot(data, now), now)).toThrow('not ready');
    expect(() =>
      launchVariables({ ...body, protocol: 'TCP' }, snapshot(fixture(), now), now)
    ).toThrow('not supported');
    expect(() =>
      launchVariables({ ...body, leaseHours: 73 }, snapshot(fixture(), now), now)
    ).toThrow('Lease');
  });
  it('rejects foreign ownership and the operator-only cleanup action', () => {
    const state = snapshot(fixture(), now);
    expect(() => launchVariables({ action: 'remove', shareId: 'ps-999' }, state)).toThrow(
      'does not belong'
    );
    expect(() => launchVariables({ action: 'cleanup' }, state)).toThrow('Choose');
  });
  it('enforces owner and global budgets independently', () => {
    const data = fixture();
    data.catalog.maxPerOwner = 1;
    data.objects = [resource()];
    expect(() => launchVariables(body, snapshot(data, now), now)).toThrow('limit');
    data.catalog.maxActive = 1;
    data.objects = [resource('ps-8', 'aap-user-8')];
    expect(() => launchVariables(body, snapshot(data, now), now)).toThrow('limit');
  });
  it('returns required survey fields for extend and remove', () => {
    const data = fixture();
    data.objects = [resource()];
    expect(
      launchVariables({ action: 'remove', shareId: 'ps-123' }, snapshot(data, now), now)
    ).toEqual({
      public_share_action: 'remove',
      public_share_id: 'ps-123',
      public_share_protocols: ['HTTP'],
    });
  });
  it('fails closed on malformed catalog input', () => {
    expect(() => parseCatalog({})).toThrow();
    expect(() =>
      parseCatalog({
        public_share_backends: {
          unsafe: { service: 'x', tailnet_fqdn: 'internal.example.com', ports: { HTTP: 80 } },
        },
      })
    ).toThrow();
  });
});
