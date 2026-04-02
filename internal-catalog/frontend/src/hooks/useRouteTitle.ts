import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { getRouteByPath } from "../lib/routes";

/**
 * Sets document.title based on the current route config.
 * Falls back to the provided title or "API Catalog Admin".
 */
export function useRouteTitle(fallbackTitle?: string) {
  const location = useLocation();

  useEffect(() => {
    const route = getRouteByPath(location.pathname);
    const title = route?.title ?? fallbackTitle ?? "API Catalog Admin";
    document.title = `${title} | API Catalog Admin`;
  }, [location.pathname, fallbackTitle]);
}
