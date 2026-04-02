import { Link, useLocation } from "react-router-dom";
import { getBreadcrumbs } from "../lib/routes";

export function Breadcrumbs() {
  const location = useLocation();
  const trail = getBreadcrumbs(location.pathname);

  if (trail.length <= 1) return null;

  return (
    <nav aria-label="Breadcrumb" className="breadcrumb-nav">
      <ol className="breadcrumb-list">
        {trail.map((route, index) => {
          const isLast = index === trail.length - 1;
          const label = route.breadcrumbLabel ?? route.label;
          return (
            <li key={route.path} className="breadcrumb-item">
              {isLast ? (
                <span aria-current="page">{label}</span>
              ) : (
                <Link to={route.path}>{label}</Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
