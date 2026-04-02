export interface RouteConfig {
  path: string;
  label: string;
  title: string;
  icon?: string;
  group?: string;
  description?: string;
  parent?: string;
  breadcrumbLabel?: string;
}

export const routes: Record<string, RouteConfig> = {
  services:  { path: "/",          label: "Services",  title: "Services",       group: "operations", description: "Browse and manage deployed API services" },
  provision: { path: "/provision", label: "Provision", title: "Provision",      group: "operations", description: "Select and deploy API services", parent: "services" },
  recovery:  { path: "/recovery",  label: "Recovery",  title: "Recovery Queue", group: "operations", description: "Recover services from failed provisioning runs", parent: "services" },
  settings:  { path: "/settings",  label: "Settings",  title: "Settings",       group: "admin",      description: "Configure team credentials and workspace settings", parent: "services" },
  docs:      { path: "/docs",      label: "Docs",      title: "Documentation",  group: "admin",      description: "Reference documentation for the catalog platform", parent: "services" },
};

export function getRouteByPath(path: string): RouteConfig | undefined {
  return Object.values(routes).find(r => r.path === path);
}

export function getBreadcrumbs(path: string): RouteConfig[] {
  const current = getRouteByPath(path);
  if (!current) return [];

  const chain: RouteConfig[] = [current];

  let cursor = current;
  while (cursor.parent) {
    const parentKey = cursor.parent;
    const parentRoute = routes[parentKey];
    if (!parentRoute) break;
    chain.unshift(parentRoute);
    cursor = parentRoute;
  }

  return chain;
}
