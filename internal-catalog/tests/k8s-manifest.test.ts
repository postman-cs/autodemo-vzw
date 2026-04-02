import { describe, it, expect } from "vitest";
import { renderK8sManifest } from "../.github/actions/aws-deploy/src/index";

describe("renderK8sManifest", () => {
  const args = [
    "vzw-partner-demo", // namespace
    "test-project",    // projectSlug
    "test-deployment", // deploymentName
    "test-service",    // serviceName
    "test-ingress",     // ingressName
    "example.com",     // baseDomain
    "mock-image:latest", // imageUri
    '{"hard":["http://dep1"],"soft":[]}', // depTargetsJson
    false,             // chaosEnabled
    "{}",              // chaosConfig
  ] as const;

  it("includes a ConfigMap with dependency targets", () => {
    const manifest = (renderK8sManifest as any)(...args);
    
    expect(manifest).toContain("kind: ConfigMap");
    expect(manifest).toContain("name: dep-targets-test-project");
    expect(manifest).toContain('dependencies.json: |');
    expect(manifest).toContain('{"hard":["http://dep1"],"soft":[]}');
  });

  it("includes volume mount and volume for the ConfigMap", () => {
    const manifest = (renderK8sManifest as any)(...args);

    expect(manifest).toContain("volumeMounts:");
    expect(manifest).toContain("mountPath: /etc/config");
    expect(manifest).toContain("name: config-volume");
    
    expect(manifest).toContain("volumes:");
    expect(manifest).toContain("name: config-volume");
    expect(manifest).toContain("name: dep-targets-test-project");
  });

  it("still includes DEPENDENCY_TARGETS_JSON env var for backward compatibility", () => {
    const manifest = (renderK8sManifest as any)(...args);

    expect(manifest).toContain("name: OTEL_PROPAGATORS");
    expect(manifest).toContain("value: 'tracecontext,baggage,b3,b3multi'");
    expect(manifest).toContain("name: DEPENDENCY_TARGETS_JSON");
    expect(manifest).toContain("value: '{\"hard\":[\"http://dep1\"],\"soft\":[]}'");
  });

  it("renders discovery manifests with Recreate and without dedicated-node scheduling labels", () => {
    const manifest = (renderK8sManifest as any)(...args, {
      hostNetwork: false,
      discoveryMode: true,
    });

    expect(manifest).toContain("strategy:\n    type: Recreate");
    expect(manifest).not.toContain("catalog.postman.com/dedicated-ip");
    expect(manifest).not.toContain("podAntiAffinity:");
    expect(manifest).not.toContain("topologySpreadConstraints:");
    expect(manifest).not.toContain("hostNetwork: true");
    expect(manifest).not.toContain("ClusterFirstWithHostNet");
    expect(manifest).not.toContain("hostPort:");
  });
});
