import { createFrontendPlugin, createRouteRef, PageBlueprint } from '@backstage/frontend-plugin-api';

const rootRouteRef = createRouteRef();

const sharingPage = PageBlueprint.make({
  params: {
    path: '/public-sharing',
    routeRef: rootRouteRef,
    title: 'Service sharing',
    loader: () => import('./SharingPage').then((module) => <module.SharingPage />),
  },
});

export default createFrontendPlugin({
  pluginId: 'public-sharing',
  extensions: [sharingPage],
});
