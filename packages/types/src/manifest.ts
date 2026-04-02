export interface CanonicalManifestService {
  id: string;
  title: string;
  runtime: string;
  sourceSpec: string;
  workspaceId: string;
  postmanWorkspaceUrl: string;
  apiSlug: string;
  fernDocsUrl: string;
  dependsOn: string[];
  consumesApis: string[];
}

export interface CanonicalManifestTab {
  slug: string;
  title: string;
  serviceCount: number;
  services: CanonicalManifestService[];
}

export interface CanonicalManifest {
  manifestVersion: string;
  docsSiteUrl: string;
  postmanWorkspaceBaseUrl: string;
  serviceCount: number;
  tabCount: number;
  tabs: CanonicalManifestTab[];
  fernRuntimeRouteMap: Record<string, string>;
}
