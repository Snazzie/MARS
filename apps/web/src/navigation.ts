import type { AnyRoute } from "@tanstack/react-router";
import type { FileRoutesByTo } from "./routeTree.gen.ts";

export type NavigationHelp = { label: string; text: string };
export type RouteNavigation = {
  label: string;
  order: number;
  section: "primary" | "settings";
  adminOnly?: boolean;
  help?: NavigationHelp;
};

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    navigation?: RouteNavigation;
  }
}

export type NavigationItem = RouteNavigation & {
  routeId: string;
  to: keyof FileRoutesByTo;
  children: NavigationItem[];
};

export function buildRouteNavigation(routes: readonly AnyRoute[], section: RouteNavigation["section"], isAdmin: boolean) {
  const byRouteId = new Map<string, NavigationItem>();
  for (const route of routes) {
    const metadata = route.options.staticData?.navigation;
    if (!metadata || metadata.section !== section || (metadata.adminOnly && !isAdmin)) continue;
    const to = (route.fullPath === "/" ? "/" : route.fullPath.replace(/\/$/, "")) as keyof FileRoutesByTo;
    byRouteId.set(route.id, { ...metadata, routeId: route.id, to, children: [] });
  }
  const items: NavigationItem[] = [];
  for (const route of routes) {
    const item = byRouteId.get(route.id);
    if (!item) continue;
    let parent = route.parentRoute;
    while (parent && !byRouteId.has(parent.id)) parent = parent.parentRoute;
    if (parent) byRouteId.get(parent.id)!.children.push(item);
    else items.push(item);
  }
  const sort = (items: NavigationItem[]) => {
    items.sort((a, b) => a.order - b.order);
    for (const item of items) sort(item.children);
  };
  sort(items);
  return { items, byRouteId };
}
