import { useCallback, useEffect, useRef, useState } from 'react';
import { discoveryApiRef, fetchApiRef, useApi } from '@backstage/core-plugin-api';
import { Content, Header, Page } from '@backstage/core-components';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
  TextField,
} from '@material-ui/core';

type Protocol = 'HTTP' | 'TCP' | 'UDP';
type State = {
  connected: true;
  username: string;
  observedAt: string;
  gatewayReady: boolean;
  httpsAvailable: boolean;
  backends: {
    name: string;
    protocols: Protocol[];
    ready: boolean;
    reason: string;
  }[];
  freePorts: { TCP: number[]; UDP: number[] };
  limits: {
    maxLeaseHours: number;
    maxActive: number;
    maxPerOwner: number;
    active: number;
    ownActive: number;
  };
  shares: {
    id: string;
    endpoints: string[];
    expiration: string;
    inconsistentExpiry: boolean;
    status: string;
  }[];
};
type Job = { id: number; url: string; status?: string; shareId?: string };
export type SharingRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function SharingPageContent({ request }: { request: SharingRequest }) {
  const [state, setState] = useState<State>();
  const [connected, setConnected] = useState<boolean>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [backend, setBackend] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('HTTP');
  const [port, setPort] = useState<number | ''>('');
  const [lease, setLease] = useState(2);
  const [subdomain, setSubdomain] = useState('');
  const [remove, setRemove] = useState('');
  const [job, setJob] = useState<Job>();
  const sequence = useRef(0);
  const mounted = useRef(true);
  const loading = useRef(false);

  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    const seq = ++sequence.current;
    try {
      const data = await request<State | { connected: false }>('/state');
      if (!mounted.current || seq !== sequence.current) return;
      setConnected(data.connected);
      setState(data.connected ? data : undefined);
      setError('');
    } catch (e) {
      if (!mounted.current || seq !== sequence.current) return;
      setState(undefined); // Never leave stale controls enabled after a failed read.
      setError(e instanceof Error ? e.message : 'Unable to refresh runtime state');
    } finally {
      loading.current = false;
    }
  }, [request]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    const onMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data?.type === 'public-sharing-oauth')
        void refresh();
    };
    window.addEventListener('message', onMessage);
    return () => {
      mounted.current = false;
      sequence.current++;
      window.clearInterval(timer);
      window.removeEventListener('message', onMessage);
    };
  }, [refresh]);

  useEffect(() => {
    if (!state) return;
    const b = state.backends.find((item) => item.name === backend);
    if (!b) {
      setBackend('');
      setPort('');
      return;
    }
    if (!b.protocols.includes(protocol)) {
      setProtocol(b.protocols[0]);
      setPort('');
    }
    if (protocol !== 'HTTP' && port !== '' && !state.freePorts[protocol].includes(port))
      setPort('');
  }, [state, backend, protocol, port]);

  useEffect(() => {
    if (!job || ['successful', 'failed', 'error', 'canceled'].includes(job.status ?? ''))
      return undefined;
    let active = true;
    const poll = async () => {
      try {
        const result = await request<Job>(`/jobs/${job.id}`);
        if (!active) return;
        setJob(result);
        if (['successful', 'failed', 'error', 'canceled'].includes(result.status ?? ''))
          void refresh();
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Unable to check the AAP job');
      }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    void poll();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status, request, refresh]);

  const connect = async () => {
    // Open before awaiting the API so popup blockers do not suppress the login.
    const popup = window.open('', 'public-sharing-aap', 'popup,width=720,height=760');
    setBusy(true);
    try {
      const { url } = await request<{ url: string }>('/oauth/start', {
        method: 'POST',
      });
      if (popup) popup.location.href = url;
      else setError('Allow the AAP sign-in popup, then connect again');
    } catch (e) {
      popup?.close();
      setError(e instanceof Error ? e.message : 'Unable to connect AAP');
    } finally {
      setBusy(false);
    }
  };
  const launch = async (action: string, shareId?: string) => {
    setBusy(true);
    setError('');
    try {
      setJob(
        await request<Job>('/shares', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            shareId,
            backend,
            protocol,
            port,
            leaseHours: lease,
            subdomain,
          }),
        })
      );
      setRemove('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to launch AAP');
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await request('/disconnect', { method: 'POST' });
    } catch {
      /* Local session is removed even if remote token revocation fails. */
    } finally {
      setState(undefined);
      setConnected(false);
      setJob(undefined);
      setBusy(false);
    }
  };
  const selected = state?.backends.find((b) => b.name === backend);
  const jobRunning = Boolean(
    job && !['successful', 'failed', 'error', 'canceled'].includes(job.status ?? '')
  );
  const disabled = busy || jobRunning;
  const atLimit =
    state &&
    (state.limits.active >= state.limits.maxActive ||
      state.limits.ownActive >= state.limits.maxPerOwner);
  const subdomainError =
    subdomain === ''
      ? ''
      : !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)
      ? 'Use 1-63 lowercase letters, digits or internal hyphens.'
      : ['www', 'gotify'].includes(subdomain) || subdomain.startsWith('ps-')
      ? 'This subdomain is reserved.'
      : '';
  const canCreate =
    state &&
    selected?.ready &&
    state.gatewayReady &&
    !atLimit &&
    selected.protocols.includes(protocol) &&
    (protocol === 'HTTP' ? state.httpsAvailable : port !== '') &&
    !subdomainError;

  return (
    <>
      <Box display="flex" flexWrap="wrap" alignItems="center" style={{ gap: 12 }} mb={2}>
        <Button variant="outlined" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </Button>
        {connected && (
          <Button onClick={() => void disconnect()} disabled={disabled}>
            Disconnect AAP
          </Button>
        )}
        <Typography variant="body2">
          {state
            ? `AAP account: ${state.username} · Checked ${new Date(
                state.observedAt
              ).toLocaleTimeString()}`
            : 'Runtime state must be available before sharing.'}
        </Typography>
      </Box>
      {error && (
        <Box role="alert" mb={2}>
          <Typography color="error">{error}</Typography>
          <Button onClick={() => void connect()} disabled={busy}>
            Reconnect AAP
          </Button>
        </Box>
      )}
      {connected === undefined && !error && <CircularProgress aria-label="Loading sharing state" />}
      {connected === false && (
        <Paper style={{ padding: 24 }}>
          <Typography paragraph>
            Connect your AAP account to view and manage your shares.
          </Typography>
          <Button
            variant="contained"
            color="primary"
            disabled={busy}
            onClick={() => void connect()}
          >
            Connect AAP
          </Button>
        </Paper>
      )}
      {job && (
        <Box mb={2} role="status">
          <Typography>
            <Link href={job.url} target="_blank" rel="noopener noreferrer">
              AAP job {job.id}
            </Link>
            : {job.status ?? 'Submitted'}
            {job.shareId && ` · ${job.shareId}`}
          </Typography>
        </Box>
      )}
      {state && (
        <>
          <Paper style={{ padding: 24, marginBottom: 24 }}>
            <Typography variant="h6" paragraph>
              Share a service
            </Typography>
            {!state.gatewayReady && (
              <Typography color="error" paragraph>
                The public gateway is not ready.
              </Typography>
            )}
            {atLimit && (
              <Typography color="error" paragraph>
                The active share limit has been reached.
              </Typography>
            )}
            <Box display="flex" flexWrap="wrap" style={{ gap: 24 }}>
              <TextField
                id="sharing-subdomain"
                label="Endpoint subdomain"
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                disabled={disabled}
                inputProps={{ maxLength: 63 }}
                error={Boolean(subdomainError)}
                helperText={
                  subdomainError ||
                  (subdomain
                    ? `${subdomain}.igou.io`
                    : 'Optional; blank generates ps-<job>.igou.io')
                }
              />
              <FormControl style={{ minWidth: 220 }} disabled={disabled}>
                <InputLabel id="sharing-backend">Service</InputLabel>
                <Select
                  labelId="sharing-backend"
                  value={backend}
                  onChange={(e) => {
                    setBackend(String(e.target.value));
                    setPort('');
                  }}
                >
                  {state.backends.map((b) => (
                    <MenuItem key={b.name} value={b.name} disabled={!b.ready}>
                      {b.name}
                      {b.ready ? '' : ' — offline'}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl style={{ minWidth: 130 }} disabled={disabled || !selected}>
                <InputLabel id="sharing-protocol">Protocol</InputLabel>
                <Select
                  labelId="sharing-protocol"
                  value={selected?.protocols.includes(protocol) ? protocol : ''}
                  onChange={(e) => {
                    setProtocol(e.target.value as Protocol);
                    setPort('');
                  }}
                >
                  {selected?.protocols.map((p) => (
                    <MenuItem key={p} value={p}>
                      {p === 'HTTP' ? 'HTTPS' : p}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {selected && protocol !== 'HTTP' && (
                <FormControl style={{ minWidth: 140 }} disabled={disabled}>
                  <InputLabel id="sharing-port">Available port</InputLabel>
                  <Select
                    labelId="sharing-port"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                  >
                    {state.freePorts[protocol].map((p) => (
                      <MenuItem key={p} value={p}>
                        {p}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
              <FormControl style={{ minWidth: 130 }} disabled={disabled}>
                <InputLabel id="sharing-lease">Lease</InputLabel>
                <Select
                  labelId="sharing-lease"
                  value={lease}
                  onChange={(e) => setLease(Number(e.target.value))}
                >
                  {[...new Set([1, 2, 8, 24, state.limits.maxLeaseHours])]
                    .filter((h) => h <= state.limits.maxLeaseHours)
                    .sort((a, b) => a - b)
                    .map((h) => (
                      <MenuItem key={h} value={h}>
                        {h} hours
                      </MenuItem>
                    ))}
                </Select>
              </FormControl>
            </Box>
            <Box mt={3}>
              <Button
                variant="contained"
                color="primary"
                disabled={disabled || !canCreate}
                onClick={() => void launch('create')}
              >
                Share service
              </Button>
            </Box>
            <Box mt={2}>
              <Typography variant="body2">
                Your shares: {state.limits.ownActive}/{state.limits.maxPerOwner}. Total:{' '}
                {state.limits.active}/{state.limits.maxActive}.
              </Typography>
            </Box>
            <Typography variant="body2">
              Expiry is enforced by the next successful hourly cleanup. Public endpoints require
              their own access controls.
            </Typography>
          </Paper>
          <Typography variant="h6" paragraph>
            My shares
          </Typography>
          {!state.shares.length ? (
            <Typography>No active shares.</Typography>
          ) : (
            <Box style={{ overflowX: 'auto' }}>
              <Table aria-label="My shares">
                <TableHead>
                  <TableRow>
                    {['Share', 'Endpoint', 'Expires', 'State', 'Actions'].map((h) => (
                      <TableCell key={h}>{h}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {state.shares.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>{s.id}</TableCell>
                      <TableCell>
                        {s.endpoints.map((e) => (
                          <div key={e}>
                            {e.startsWith('https://') ? (
                              <Link href={e} target="_blank" rel="noopener noreferrer">
                                {e}
                              </Link>
                            ) : (
                              e
                            )}
                          </div>
                        ))}
                      </TableCell>
                      <TableCell>
                        {new Date(s.expiration).toLocaleString()}
                        {s.inconsistentExpiry && ' (inconsistent; renew to repair)'}
                      </TableCell>
                      <TableCell>{s.status}</TableCell>
                      <TableCell>
                        <Button disabled={disabled} onClick={() => void launch('extend', s.id)}>
                          Extend {lease}h
                        </Button>
                        <Button disabled={disabled} onClick={() => setRemove(s.id)}>
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
          <Box mt={2}>
            <Typography variant="body2">
              Configured means the route and proxy are ready. It does not establish public
              reachability.
            </Typography>
          </Box>
        </>
      )}
      <Dialog open={Boolean(remove)} onClose={() => setRemove('')}>
        <DialogTitle>Remove {remove}?</DialogTitle>
        <DialogContent>This stops public forwarding for this share.</DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setRemove('')}>
            Cancel
          </Button>
          <Button color="secondary" disabled={busy} onClick={() => void launch('remove', remove)}>
            Remove share
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export function SharingPage() {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const request = useCallback<SharingRequest>(
    async (path, init) => {
      const response = await fetchApi.fetch(
        `${await discovery.getBaseUrl('public-sharing')}${path}`,
        init
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Sharing service is unavailable');
      return data;
    },
    [discovery, fetchApi]
  );
  return (
    <Page themeId="tool">
      <Header title="Service sharing" subtitle="Temporary public access through the VPS" />
      <Content>
        <SharingPageContent request={request} />
      </Content>
    </Page>
  );
}
