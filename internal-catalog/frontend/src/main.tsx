import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "./contexts/ThemeContext";
import { Layout } from "./components/Layout";
import { RouteErrorBoundary } from "./components/ErrorBoundary";
import { Skeleton } from "./components/Skeleton";
import "./styles.css";

const CatalogPage = lazy(() => import("./pages/CatalogPage").then(m => ({ default: m.CatalogPage })));
const ProvisionLayout = lazy(() => import("./components/ProvisionLayout").then(m => ({ default: m.ProvisionLayout })));
const ProvisionPage = lazy(() => import("./pages/ProvisionPage").then(m => ({ default: m.ProvisionPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then(m => ({ default: m.SettingsPage })));
const RecoveryPage = lazy(() => import("./pages/RecoveryPage").then(m => ({ default: m.RecoveryPage })));
const DocsPage = lazy(() => import("./pages/DocsPage").then(m => ({ default: m.DocsPage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then(m => ({ default: m.NotFoundPage })));

const verizonFaviconUrl =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23ee0000' d='M22.5 2L9.75 22l-4.5-8.5L8.25 13l1.5 2.85L19.5 2h3z'/%3E%3C/svg%3E";
const favicon = document.querySelector<HTMLLinkElement>("link[rel='icon']") ?? document.createElement("link");
favicon.rel = "icon";
favicon.type = "image/svg+xml";
favicon.href = verizonFaviconUrl;
if (!favicon.parentNode) {
  document.head.appendChild(favicon);
}

document.title = "Verizon Service Deployment Portal";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <Suspense fallback={<div className="page-loading"><Skeleton variant="text" width="200px" /><Skeleton variant="rect" height="300px" /></div>}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<RouteErrorBoundary><CatalogPage /></RouteErrorBoundary>} />
              <Route path="recovery" element={<RouteErrorBoundary><RecoveryPage /></RouteErrorBoundary>} />
              <Route path="provision" element={<RouteErrorBoundary><ProvisionLayout /></RouteErrorBoundary>}>
              <Route index element={<RouteErrorBoundary><ProvisionPage /></RouteErrorBoundary>} />
            </Route>
              <Route path="settings" element={<RouteErrorBoundary><SettingsPage /></RouteErrorBoundary>} />
              <Route path="docs" element={<RouteErrorBoundary><DocsPage /></RouteErrorBoundary>} />
              <Route path="*" element={<RouteErrorBoundary><NotFoundPage /></RouteErrorBoundary>} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>
);
