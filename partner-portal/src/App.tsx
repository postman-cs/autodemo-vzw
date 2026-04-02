import { Navigate, Link, Route, Routes } from "react-router-dom";
import { VerizonCheckmark } from "./components";
import { HomePage } from "./pages/HomePage";
import { ServiceDetailPage } from "./pages/ServiceDetailPage";

export default function App() {
  return (
    <>
      <header className="portal-header">
        <div className="portal-header-inner">
          <Link className="portal-brand" to="/" aria-label="Verizon Partner Portal">
            <VerizonCheckmark />
            Verizon Partner Portal
          </Link>
          <nav className="portal-nav" aria-label="Primary">
            <a href="https://partner.vzw.pm-demo.dev/docs/" target="_blank" rel="noreferrer">
              Documentation
            </a>
            <a href="https://www.postman.com/" target="_blank" rel="noreferrer">
              Tools
            </a>
            <a href="https://www.postman.com/api-platform/api-client/" target="_blank" rel="noreferrer">
              SDKs
            </a>
            <a href="https://partner.vzw.pm-demo.dev" target="_blank" rel="noreferrer">
              Support
            </a>
          </nav>
        </div>
      </header>

      <div className="shell">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/services/:serviceId" element={<ServiceDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </>
  );
}
