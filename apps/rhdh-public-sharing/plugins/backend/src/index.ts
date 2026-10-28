import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { AuthenticationError, InputError, NotAllowedError } from '@backstage/errors';
import { randomBytes } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { SharingService } from './service';

export default createBackendPlugin({
  pluginId: 'public-sharing',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        reader: coreServices.urlReader,
      },
      async init({ config, httpRouter, httpAuth, reader }) {
        const service = new SharingService(config, reader);
        const router = express.Router();
        router.use(express.json({ limit: '8kb' }));
        router.use((_req, res, next) => {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Referrer-Policy', 'no-referrer');
          next();
        });
        const user = async (req: Request) =>
          (await httpAuth.credentials(req, { allow: ['user'] })).principal.userEntityRef;
        const handle =
          (fn: (req: Request, res: Response) => Promise<unknown>) =>
          (req: Request, res: Response, next: NextFunction) => {
            Promise.resolve(fn(req, res)).catch(next);
          };
        router.post(
          '/oauth/start',
          handle(async (req, res) => res.json({ url: service.start(await user(req)) }))
        );
        router.get(
          '/oauth/callback',
          handle(async (req, res) => {
            let success = false;
            if (typeof req.query.state === 'string' && typeof req.query.code === 'string') {
              try {
                await service.callback(req.query.state, req.query.code);
                success = true;
              } catch {
                /* Do not log OAuth codes. */
              }
            }
            const nonce = randomBytes(24).toString('base64');
            res.setHeader(
              'Content-Security-Policy',
              `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`
            );
            res
              .type('html')
              .send(
                `<!doctype html><meta charset="utf-8"><title>AAP connection</title><p>${
                  success
                    ? 'AAP connected. Return to Service sharing.'
                    : 'AAP connection failed. Return to Service sharing and reconnect.'
                }</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage({type:'public-sharing-oauth',success:${success}},${JSON.stringify(
                  service.appOrigin
                )});window.close();}</script>`
              );
          })
        );
        router.post(
          '/disconnect',
          handle(async (req, res) => {
            await service.disconnect(await user(req));
            res.json({ connected: false });
          })
        );
        router.get(
          '/state',
          handle(async (req, res) => res.json(await service.state(await user(req))))
        );
        router.post(
          '/shares',
          handle(async (req, res) =>
            res.status(202).json(await service.launch(await user(req), req.body))
          )
        );
        router.get(
          '/jobs/:id',
          handle(async (req, res) => {
            if (!/^[1-9][0-9]{0,12}$/.test(req.params.id)) throw new InputError('Invalid job ID');
            return res.json(await service.job(await user(req), Number(req.params.id)));
          })
        );
        router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
          const status =
            err instanceof AuthenticationError
              ? 401
              : err instanceof NotAllowedError
              ? 403
              : err instanceof InputError
              ? 400
              : 503;
          res
            .status(status)
            .json({
              error:
                status === 503
                  ? 'Runtime state or AAP is unavailable. Refresh before retrying.'
                  : err.message,
            });
        });
        httpRouter.addAuthPolicy({ path: '/oauth/callback', allow: 'unauthenticated' });
        httpRouter.use(router);
      },
    });
  },
});
