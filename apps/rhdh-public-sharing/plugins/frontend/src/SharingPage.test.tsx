// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SharingPageContent, type SharingRequest } from './SharingPage';

const ready = () => ({
  connected: true,
  username: 'caller',
  observedAt: new Date().toISOString(),
  gatewayReady: true,
  httpsAvailable: true,
  backends: [{ name: 'web', protocols: ['HTTP'], ready: true, reason: '' }],
  freePorts: { TCP: [27010], UDP: [27018] },
  shares: [],
  limits: {
    maxLeaseHours: 72,
    maxActive: 8,
    maxPerOwner: 3,
    active: 0,
    ownActive: 0,
  },
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('runtime sharing page', () => {
  it('offers connection without displaying a stale form', async () => {
    const request = vi.fn(async () => ({
      connected: false,
    })) as unknown as SharingRequest;
    render(<SharingPageContent request={request} />);
    await screen.findByText('Connect AAP');
    expect(screen.queryByText('Share service')).toBeNull();
  });
  it('shows offline catalog entries and prevents sharing them', async () => {
    const data = ready();
    data.backends[0].ready = false;
    const request = vi.fn(async () => data) as unknown as SharingRequest;
    render(<SharingPageContent request={request} />);
    await screen.findByText(/AAP account: caller/);
    expect(
      (
        screen.getByRole('button', {
          name: 'Share service',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    fireEvent.mouseDown(screen.getByLabelText('Service'));
    expect(screen.getByRole('option', { name: /web.*offline/ }).getAttribute('aria-disabled')).toBe(
      'true'
    );
  });
  it('launches once with selected survey inputs', async () => {
    const request = vi.fn(async (path: string) =>
      path === '/shares'
        ? {
            id: 123,
            url: 'https://aap.example.com/jobs/123',
            status: 'successful',
          }
        : ready()
    ) as unknown as SharingRequest;
    render(<SharingPageContent request={request} />);
    await screen.findByText(/AAP account: caller/);
    fireEvent.mouseDown(screen.getByLabelText('Service'));
    fireEvent.click(screen.getByRole('option', { name: 'web' }));
    fireEvent.change(screen.getByLabelText('Endpoint subdomain'), {
      target: { value: 'demo' },
    });
    expect(screen.getByText('demo.sharing.igou.io')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Share service' }));
    await screen.findByText('AAP job 123');
    const calls = vi.mocked(request).mock.calls.filter(([p]) => p === '/shares');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1]!.body as string)).toMatchObject({
      action: 'create',
      backend: 'web',
      protocol: 'HTTP',
      leaseHours: 2,
      subdomain: 'demo',
    });
  });
  it('disables creation for invalid or reserved subdomains', async () => {
    const request = vi.fn(async () => ready()) as unknown as SharingRequest;
    render(<SharingPageContent request={request} />);
    await screen.findByText(/AAP account: caller/);
    fireEvent.mouseDown(screen.getByLabelText('Service'));
    fireEvent.click(screen.getByRole('option', { name: 'web' }));
    const button = screen.getByRole('button', {
      name: 'Share service',
    }) as HTMLButtonElement;
    for (const value of ['ps-123', 'demo.example', '-demo', 'Demo']) {
      fireEvent.change(screen.getByLabelText('Endpoint subdomain'), {
        target: { value },
      });
      expect(button.disabled).toBe(true);
    }
    fireEvent.change(screen.getByLabelText('Endpoint subdomain'), {
      target: { value: '' },
    });
    expect(button.disabled).toBe(false);
    for (const value of ['www', 'gotify']) {
      fireEvent.change(screen.getByLabelText('Endpoint subdomain'), { target: { value } });
      expect(button.disabled).toBe(false);
      expect(screen.getByText(`${value}.sharing.igou.io`)).toBeTruthy();
    }
  });
  it('refreshes automatically and removes stale controls on a runtime failure', async () => {
    const interval = vi.spyOn(window, 'setInterval');
    const request = vi.fn(async () => ready());
    render(<SharingPageContent request={request as unknown as SharingRequest} />);
    await screen.findByText(/AAP account: caller/);
    request.mockRejectedValueOnce(new Error('Runtime state is unavailable'));
    const refresh = interval.mock.calls.find((call) => call[1] === 15000)![0] as () => void;
    await act(async () => {
      refresh();
    });
    expect(screen.getByRole('alert').textContent).toContain('Runtime state is unavailable');
    expect(screen.queryByText('Share service')).toBeNull();
  });
  it('requires confirmation before removing an owned share', async () => {
    const data: any = ready();
    data.shares = [
      {
        id: 'ps-123',
        endpoints: ['https://ps-123.igou.io'],
        expiration: new Date(Date.now() + 3600000).toISOString(),
        status: 'Configured',
        inconsistentExpiry: false,
      },
    ];
    const request = vi.fn(async () => data) as unknown as SharingRequest;
    render(<SharingPageContent request={request} />);
    await screen.findByText('ps-123');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(vi.mocked(request).mock.calls.some(([p]) => p === '/shares')).toBe(false);
  });
});
