import { createPlugin, createRoutableExtension, createRouteRef } from '@backstage/core-plugin-api';

export const publicSharingPlugin = createPlugin({
  id: 'public-sharing',
  routes: { root: createRouteRef({ id: 'public-sharing' }) },
});
export const PublicSharingPage = publicSharingPlugin.provide(
  createRoutableExtension({
    name: 'PublicSharingPage',
    component: () => import('./SharingPage').then((m) => m.SharingPage),
    mountPoint: publicSharingPlugin.routes.root,
  })
);
