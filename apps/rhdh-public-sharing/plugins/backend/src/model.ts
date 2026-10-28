export const ID = 'sharing.igou.io/id';
export const OWNER = 'sharing.igou.io/owner';
export const EXPIRY = 'sharing.igou.io/expires-at';
export type Protocol = 'HTTP' | 'TCP' | 'UDP';
export type KubeObject = {
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    generation?: number;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  // Kubernetes resources are read from several API groups; only fields below are used.
  spec?: any;
  status?: any;
  endpoints?: any[];
};
export type Catalog = {
  backends: Record<
    string,
    {
      service: string;
      tailnet_fqdn: string;
      service_uid?: string;
      ports: Partial<Record<Protocol, number>>;
    }
  >;
  maxLeaseHours: number;
  maxActive: number;
  maxPerOwner: number;
};

export function parseCatalog(input: any): Catalog {
  const backends = input?.public_share_backends;
  if (!backends || typeof backends !== 'object' || Array.isArray(backends)) {
    throw new Error('Approved backend catalog is unavailable');
  }
  for (const [name, backend] of Object.entries(backends) as [string, any][]) {
    if (
      !/^[a-z0-9-]{1,128}$/.test(name) ||
      !backend ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(backend.service) ||
      !/^ocp-public-[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(backend.tailnet_fqdn) ||
      !backend.ports ||
      !Object.keys(backend.ports).length ||
      Object.entries(backend.ports).some(
        ([p, port]) =>
          !['HTTP', 'TCP', 'UDP'].includes(p) ||
          !Number.isInteger(port) ||
          Number(port) < 1 ||
          Number(port) > 65535
      )
    ) {
      throw new Error('Approved backend catalog is invalid');
    }
  }
  const limit = (key: string, fallback: number, min = 1) => {
    const n = input[key] ?? fallback;
    if (!Number.isInteger(n) || n < min) throw new Error('Sharing limits are invalid');
    return n;
  };
  return {
    backends,
    maxLeaseHours: limit('public_share_max_lease_hours', 72, 2),
    maxActive: limit('public_share_max_active', 8),
    maxPerOwner: limit('public_share_max_active_per_owner', 3),
  };
}

function readyEndpoints(slices: KubeObject[], service: string) {
  return slices
    .filter((s) => s.metadata.labels?.['kubernetes.io/service-name'] === service)
    .flatMap((s) => s.endpoints ?? [])
    .filter((e) => e.conditions?.ready === true).length;
}

function routeConfigured(route: KubeObject) {
  return (route.status?.parents ?? []).some(
    (p: any) =>
      p.parentRef?.name === 'public' &&
      p.parentRef?.namespace === 'nginx-gateway' &&
      ['Accepted', 'ResolvedRefs'].every((type) =>
        p.conditions?.some(
          (c: any) =>
            c.type === type &&
            c.status === 'True' &&
            c.observedGeneration === route.metadata.generation
        )
      )
  );
}

export function snapshot(
  input: {
    catalog: Catalog;
    services: KubeObject[];
    endpoints: KubeObject[];
    objects: KubeObject[];
    proxyEndpoints: KubeObject[];
    gateway: KubeObject;
    userId: number;
  },
  now = new Date()
) {
  const { catalog, objects, gateway } = input;
  const owner = `aap-user-${input.userId}`;
  const managed = objects.filter(
    (o) =>
      o.metadata.labels?.['app.kubernetes.io/managed-by'] === 'public-share-aap' &&
      /^ps-[a-z0-9-]{1,30}$/.test(o.metadata.labels?.[ID] ?? '')
  );
  const allIds = new Set(managed.map((o) => o.metadata.labels![ID]));
  const ownIds = new Set(
    managed
      .filter((o) => o.metadata.annotations?.[OWNER] === owner)
      .map((o) => o.metadata.labels![ID])
  );
  const listeners: any[] = gateway.spec?.listeners ?? [];
  const freePorts = (protocol: 'TCP' | 'UDP', low: number, high: number) =>
    listeners
      .filter(
        (l) =>
          l.protocol === protocol &&
          l.name === `${protocol.toLowerCase()}-${l.port}` &&
          l.port >= low &&
          l.port <= high &&
          !(gateway.status?.listeners ?? []).some(
            (s: any) => s.name === l.name && s.attachedRoutes > 0
          ) &&
          !objects.some(
            (o) =>
              o.kind === `${protocol}Route` &&
              (o.spec?.parentRefs ?? []).some(
                (p: any) =>
                  p.name === 'public' &&
                  (p.namespace ?? o.metadata.namespace) === 'nginx-gateway' &&
                  (!p.sectionName || p.sectionName === l.name)
              )
          )
      )
      .map((l) => l.port as number)
      .sort((a, b) => a - b);
  const gatewayReady = ['Accepted', 'Programmed'].every((type) =>
    gateway.status?.conditions?.some(
      (c: any) =>
        c.type === type &&
        c.status === 'True' &&
        c.observedGeneration === gateway.metadata.generation
    )
  );
  const httpsAvailable =
    gatewayReady && listeners.some((l) => l.name === 'https' && l.protocol === 'HTTPS');
  const backends = Object.entries(catalog.backends).map(([name, b]) => {
    const service = input.services.find((s) => s.metadata.name === b.service);
    const validService =
      service?.spec?.type === 'LoadBalancer' &&
      service.spec.loadBalancerClass === 'tailscale' &&
      Object.keys(service.spec.selector ?? {}).length > 0 &&
      service.metadata.annotations?.['tailscale.com/hostname'] === b.tailnet_fqdn.split('.')[0] &&
      (!b.service_uid || b.service_uid === service.metadata.uid);
    const portsMatch = Object.entries(b.ports).every(([p, port]) =>
      service?.spec?.ports?.some(
        (s: any) => s.port === port && (s.protocol ?? 'TCP') === (p === 'UDP' ? 'UDP' : 'TCP')
      )
    );
    const endpoints = readyEndpoints(input.endpoints, b.service);
    return {
      name,
      protocols: Object.keys(b.ports) as Protocol[],
      ready: Boolean(validService && portsMatch && endpoints),
      readyEndpoints: endpoints,
      reason:
        !validService || !portsMatch
          ? 'Approved Service is missing or differs from the catalog'
          : endpoints
          ? ''
          : 'No ready application endpoints',
    };
  });
  const shares = [...ownIds]
    .map((id) => {
      const resources = managed.filter(
        (o) => o.metadata.labels![ID] === id && o.metadata.annotations?.[OWNER] === owner
      );
      const routes = resources.filter((o) => o.kind.endsWith('Route'));
      const expirations = [
        ...new Set(resources.map((o) => o.metadata.annotations?.[EXPIRY] ?? '')),
      ];
      const expiration = expirations.slice().sort()[0];
      const expired =
        !Number.isFinite(Date.parse(expiration)) || Date.parse(expiration) <= now.getTime();
      const proxyReady = readyEndpoints(input.proxyEndpoints, `ocp-${id}-bridge`) > 0;
      const configured =
        routes.length > 0 && routes.every(routeConfigured) && proxyReady && gatewayReady;
      const endpoints = routes.flatMap((o) =>
        o.kind === 'HTTPRoute'
          ? (o.spec?.hostnames ?? []).map((h: string) => `https://${h}`)
          : (o.spec?.parentRefs ?? []).map((p: any) => {
              const port = p.sectionName?.split('-').pop();
              return `${o.kind === 'UDPRoute' ? 'udp' : 'tcp'}://${id}.igou.io:${port}`;
            })
      );
      return {
        id,
        expiration,
        inconsistentExpiry: expirations.length !== 1,
        endpoints,
        status: expired
          ? 'Awaiting cleanup'
          : configured
          ? 'Configured'
          : 'Provisioning or incomplete',
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    observedAt: now.toISOString(),
    backends,
    shares,
    gatewayReady,
    httpsAvailable,
    freePorts: {
      TCP: gatewayReady ? freePorts('TCP', 27010, 27017) : [],
      UDP: gatewayReady ? freePorts('UDP', 27018, 27025) : [],
    },
    limits: {
      maxLeaseHours: catalog.maxLeaseHours,
      maxActive: catalog.maxActive,
      maxPerOwner: catalog.maxPerOwner,
      active: allIds.size,
      ownActive: ownIds.size,
    },
  };
}

export function launchVariables(body: any, state: ReturnType<typeof snapshot>, now = new Date()) {
  const action = body?.action;
  if (!['create', 'extend', 'remove'].includes(action))
    throw new Error('Choose create, extend, or remove');
  if (action !== 'create' && !state.shares.some((s) => s.id === body.shareId))
    throw new Error('Share does not belong to your AAP account');
  const variables: Record<string, unknown> = { public_share_action: action };
  if (action !== 'create') variables.public_share_id = body.shareId;
  if (action !== 'remove') {
    const hours = Number(body.leaseHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > state.limits.maxLeaseHours)
      throw new Error('Lease is outside the permitted range');
    variables.public_share_expires_at = new Date(now.getTime() + hours * 3600000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
  }
  if (action === 'create') {
    const backend = state.backends.find((b) => b.name === body.backend);
    if (!backend?.ready || !state.gatewayReady) throw new Error('Backend or Gateway is not ready');
    if (
      state.limits.active >= state.limits.maxActive ||
      state.limits.ownActive >= state.limits.maxPerOwner
    )
      throw new Error('Active share limit reached');
    if (!backend.protocols.includes(body.protocol))
      throw new Error('Protocol is not supported by this backend');
    if (body.protocol === 'HTTP' && !state.httpsAvailable)
      throw new Error('HTTPS listener is unavailable');
    if (body.protocol !== 'HTTP') {
      const protocol = body.protocol as 'TCP' | 'UDP';
      if (!state.freePorts[protocol].includes(Number(body.port)))
        throw new Error('Port is no longer available; refresh the menu');
      variables[protocol === 'TCP' ? 'public_share_tcp_port' : 'public_share_udp_port'] = Number(
        body.port
      );
    }
    variables.public_share_backend = backend.name;
    variables.public_share_protocols = [body.protocol];
  } else {
    // The current AAP survey requires this field for every action.
    variables.public_share_protocols = ['HTTP'];
  }
  return variables;
}
