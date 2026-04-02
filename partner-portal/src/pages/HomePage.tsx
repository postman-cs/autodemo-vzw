import { useEffect, useState } from "react";
import { fetchGraphs } from "../api";
import { ServiceCard } from "../components";
import type { GraphsResponse } from "../types";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: GraphsResponse };

export function HomePage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetchGraphs()
      .then((data) => {
        if (!cancelled) {
          setState({ status: "ready", data });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Unable to load services.",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <header className="hero">
        <div className="eyebrow">Verizon Partner Services</div>
        <h1>Explore and integrate Verizon network APIs</h1>
        <p>
          Browse available API services, review documentation, test with Postman,
          and onboard with Agent Mode across the Verizon partner ecosystem.
        </p>
      </header>

      {state.status === "loading" ? <div className="info-banner">Loading services...</div> : null}
      {state.status === "error" ? <div className="info-banner is-error">{state.message}</div> : null}

      {state.status === "ready" ? (
        <main>
          {state.data.graphs.map((graph) => (
            <section key={graph.graph_id} className="section-block">
              <div className="section-head">
                <div>
                  <h2>{graph.graph_name}</h2>
                </div>
                <span className="count-pill">{graph.services.length} APIs</span>
              </div>
              <div className="service-grid">
                {graph.services.map((service) => (
                  <ServiceCard key={service.service_id} service={service} />
                ))}
              </div>
            </section>
          ))}

          {state.data.standalone.length > 0 ? (
            <section className="section-block">
              <div className="section-head">
                <div>
                  <h2>Platform Services</h2>
                </div>
                <span className="count-pill">{state.data.standalone.length} APIs</span>
              </div>
              <div className="service-grid">
                {state.data.standalone.map((service) => (
                  <ServiceCard key={service.service_id} service={service} />
                ))}
              </div>
            </section>
          ) : null}
        </main>
      ) : null}
    </>
  );
}
