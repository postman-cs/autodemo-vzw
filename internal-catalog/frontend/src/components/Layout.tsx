import { Link, NavLink, Outlet } from "react-router-dom";
import { ToastProvider } from "../hooks/useToast";
import { ToastContainer } from "./ToastContainer";
import { routes } from "../lib/routes";
import { useTheme } from "../contexts/ThemeContext";
import { VerizonLogo } from "./VerizonLogo";

export function Layout() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <ToastProvider>
      <div className="app">
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <header className="header">
          <Link to="/" className="header-brand" aria-label="Verizon Service Deployment Portal home">
            <VerizonLogo size={22} className="header-logo" />
            <span className="header-title">Verizon Service Deployment Portal</span>
          </Link>
          <nav className="header-nav">
            {Object.entries(routes)
              .filter(([, r]) => r.group === "operations")
              .map(([key, route]) => (
                <NavLink
                  key={key}
                  to={route.path}
                  className={({ isActive }) => isActive ? "active" : ""}
                  end={route.path === "/"}
                >
                  {route.label}
                </NavLink>
              ))}

            <span className="nav-separator" aria-hidden="true" />

            {Object.entries(routes)
              .filter(([, r]) => r.group === "admin")
              .map(([key, route]) => (
                <NavLink
                  key={key}
                  to={route.path}
                  className={({ isActive }) => isActive ? "active" : ""}
                >
                  {route.label}
                </NavLink>
              ))}

            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              aria-label="Toggle dark mode"
            >
              {resolvedTheme === "dark" ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="2"/>
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>

            <a href="/auth/logout" className="nav-logout">Logout</a>
          </nav>
        </header>
        <main id="main-content" tabIndex={-1} className="main">
          <Outlet />
        </main>
      </div>
      <ToastContainer />
    </ToastProvider>
  );
}
