import { useEffect } from "react";
import { Link } from "react-router-dom";

export function NotFoundPage() {
  useEffect(() => {
    document.title = "Not Found | API Catalog Admin";
  }, []);

  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">?</span>
      <h1>Page not found</h1>
      <p>The page you requested does not exist.</p>
      <p className="not-found-hint">
        <Link to="/" className="btn btn-secondary">Back to Services</Link>
      </p>
    </div>
  );
}
