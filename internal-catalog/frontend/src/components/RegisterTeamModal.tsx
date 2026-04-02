import { useState, useRef, type ChangeEvent, type FormEvent } from "react";
import { ErrorBanner } from "./ErrorBanner";
import { Modal } from "./Modal";

interface RegisterTeamModalProps {
  onClose: () => void;
  onSuccess: (slug: string) => void;
}

interface RegisterTeamErrorResponse {
  error?: string;
}

interface RegisterTeamResponse {
  team?: { slug?: string };
}

export function RegisterTeamModal({ onClose, onSuccess }: RegisterTeamModalProps) {
  const [accessToken, setAccessToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const parsed = JSON.parse(content);

        let token = "";

        if (parsed.session?.accessToken) {
          token = parsed.session.accessToken;
        } else if (parsed.accessToken) {
          token = parsed.accessToken;
        }

        if (token) {
          setAccessToken(token);
          setError("");
        } else {
          setError("Could not find access token in the provided file.");
        }
      } catch (err) {
        setError("Failed to parse file. Make sure it is a valid postmanrc JSON file.");
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    };
    reader.readAsText(file);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) {
      setError("Access Token is required.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const payload: Record<string, string> = {
        access_token: accessToken,
      };
      if (apiKey.trim()) {
        payload.api_key = apiKey.trim();
      }

      const response = await fetch("/api/teams/registry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({})) as RegisterTeamErrorResponse;
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const data = await response.json() as RegisterTeamResponse;
      const finalSlug = data?.team?.slug;
      if (!finalSlug) {
        throw new Error("Team registered, but no slug was returned");
      }

      onSuccess(finalSlug);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  return (
    <Modal open={true} onClose={loading ? () => {} : onClose} className="register-modal-panel">
      <Modal.Header
        title="Register New Team"
        subtitle="Team identity (name, slug, ID) and organization mode will be automatically detected from your credentials. No additional configuration needed."
      />
      <Modal.Body>
        {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}

        <div className="provision-setting register-import-section">
          <label className="provision-checkbox-label register-import-label" htmlFor="postmanrc-import">
            Import from ~/.postman/postmanrc
          </label>
          <p className="modal-hint">
            Upload your local Postman CLI config file to auto-fill your access token.
          </p>
          <input
            id="postmanrc-import"
            type="file"
            accept=".json,application/json,*"
            onChange={handleFileUpload}
            ref={fileInputRef}
            disabled={loading}
            className="register-file-input"
          />
        </div>

        <form onSubmit={handleSubmit} id="register-team-form">
          <div className="provision-setting">
            <label className="provision-checkbox-label" htmlFor="access-token">Access Token (Required)</label>
            <input
              id="access-token"
              type="password"
              className="form-input"
              placeholder="eyJ..."
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div className="provision-setting">
            <label className="provision-checkbox-label" htmlFor="api-key-input">API Key (Optional)</label>
            <p className="modal-hint">
              Provide an existing PMAK to skip automatic key generation.
            </p>
            <input
              id="api-key-input"
              type="password"
              className="form-input"
              placeholder="PMAK-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={loading}
            />
          </div>
        </form>
      </Modal.Body>
      <Modal.Footer>
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={loading}>Cancel</button>
        <button type="submit" form="register-team-form" className="btn btn-primary" disabled={loading}>
          {loading ? "Registering..." : "Register Team"}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
