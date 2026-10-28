import https from 'node:https';

// No redirects: never forward OAuth or Kubernetes credentials to another origin.
export function requestJson<T = any>(
  url: string,
  options: {
    token?: string;
    ca?: string;
    method?: string;
    body?: unknown;
    form?: URLSearchParams;
    basic?: string;
  } = {}
): Promise<T> {
  if (new URL(url).protocol !== 'https:') throw new Error('HTTPS is required');
  const payload =
    options.form?.toString() ??
    (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: options.method ?? 'GET',
        ca: options.ca,
        signal: AbortSignal.timeout(10000),
        headers: {
          Accept: 'application/json',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.basic
            ? { Authorization: `Basic ${Buffer.from(options.basic).toString('base64')}` }
            : {}),
          ...(payload
            ? {
                'Content-Type': options.form
                  ? 'application/x-www-form-urlencoded'
                  : 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4 * 1024 * 1024)
            req.destroy(new Error('Response exceeded the permitted size'));
        });
        res.on('error', () => reject(new Error('Upstream response failed')));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            // Upstream error bodies may contain credentials or inventory values.
            reject(new Error(`Upstream request failed (${res.statusCode ?? 'unknown'})`));
            return;
          }
          if (!body.trim()) {
            resolve(undefined as T);
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Upstream returned invalid JSON'));
          }
        });
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error('Upstream request timed out')));
    req.on('error', () => reject(new Error('Upstream connection failed')));
    if (payload) req.write(payload);
    req.end();
  });
}
