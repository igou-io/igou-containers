export interface Config {
  publicSharing: {
    catalogUrl: string;
    aap: {
      baseUrl: string;
      clientId: string;
      /** @visibility secret */
      clientSecret: string;
      templateName?: string;
    };
    clusters: {
      ocp: { server: string; tokenFile: string; caFile: string };
      vps: { server: string; tokenFile: string; caFile: string };
    };
  };
}
