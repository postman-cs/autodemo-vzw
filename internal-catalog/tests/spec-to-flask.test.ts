import { describe, it, expect } from "vitest";
import { generateFlaskRoutes } from "../src/lib/spec-to-flask";

// Minimal spec that mirrors the boilerplate structure: health + 6 resource groups
const BOILERPLATE_SPEC = `
openapi: "3.0.3"
info:
  title: Platform Management API
  version: "1.0.0"
  contact:
    name: Platform Engineering Team
servers:
  - url: "{baseUrl}"
    variables:
      baseUrl:
        default: http://localhost:5000
security:
  - bearerAuth: []
tags:
  - name: Operations
  - name: Users
  - name: Organizations
  - name: Projects
  - name: Tasks
  - name: Comments
  - name: Webhooks
paths:
  /health:
    get:
      operationId: healthCheck
      summary: Health check
      tags: [Operations]
      security: []
      responses:
        "200":
          description: OK
  /api/v1/users:
    get:
      operationId: listUsers
      tags: [Users]
      responses:
        "200": {description: OK}
    post:
      operationId: createUser
      tags: [Users]
      requestBody:
        required: true
        content:
          application/json:
            schema: {type: object}
      responses:
        "201": {description: Created}
  /api/v1/users/{userId}:
    get:
      operationId: getUser
      tags: [Users]
      responses:
        "200": {description: OK}
    put:
      operationId: updateUser
      tags: [Users]
      requestBody:
        required: true
        content:
          application/json:
            schema: {type: object}
      responses:
        "200": {description: OK}
    delete:
      operationId: deleteUser
      tags: [Users]
      responses:
        "204": {description: No Content}
  /api/v1/organizations:
    get:
      operationId: listOrganizations
      tags: [Organizations]
      responses:
        "200": {description: OK}
    post:
      operationId: createOrganization
      tags: [Organizations]
      requestBody:
        required: true
        content:
          application/json:
            schema: {type: object}
      responses:
        "201": {description: Created}
  /api/v1/organizations/{orgId}:
    get:
      operationId: getOrganization
      tags: [Organizations]
      responses:
        "200": {description: OK}
    put:
      operationId: updateOrganization
      tags: [Organizations]
      requestBody:
        required: true
        content:
          application/json:
            schema: {type: object}
      responses:
        "200": {description: OK}
  /api/v1/organizations/{orgId}/members:
    get:
      operationId: listOrgMembers
      tags: [Organizations]
      responses:
        "200": {description: OK}
  /api/v1/projects:
    get:
      operationId: listProjects
      tags: [Projects]
      responses:
        "200": {description: OK}
    post:
      operationId: createProject
      tags: [Projects]
      requestBody:
        required: true
        content:
          application/json:
            schema: {type: object}
      responses:
        "201": {description: Created}
  /api/v1/projects/{projectId}:
    get:
      operationId: getProject
      tags: [Projects]
      responses:
        "200": {description: OK}
    put:
      operationId: updateProject
      tags: [Projects]
      requestBody:
        required: true
        content:
          application/json:
            schema: {type: object}
      responses:
        "200": {description: OK}
    delete:
      operationId: archiveProject
      tags: [Projects]
      responses:
        "204": {description: No Content}
  /api/v1/projects/{projectId}/tasks:
    get:
      operationId: listTasks
      tags: [Tasks]
      responses:
        "200": {description: OK}
    post:
      operationId: createTask
      tags: [Tasks]
      requestBody:
        required: true
        content:
          application/json:
            schema: {type: object}
      responses:
        "201": {description: Created}
  /api/v1/projects/{projectId}/tasks/{taskId}:
    get:
      operationId: getTask
      tags: [Tasks]
      responses:
        "200": {description: OK}
    put:
      operationId: updateTask
      tags: [Tasks]
      requestBody:
        required: true
        content:
          application/json:
            schema: {type: object}
      responses:
        "200": {description: OK}
    delete:
      operationId: deleteTask
      tags: [Tasks]
      responses:
        "204": {description: No Content}
  /api/v1/projects/{projectId}/tasks/{taskId}/comments:
    get:
      operationId: listComments
      tags: [Comments]
      responses:
        "200": {description: OK}
    post:
      operationId: createComment
      tags: [Comments]
      requestBody:
        required: true
        content:
          application/json:
            schema: {type: object}
      responses:
        "201": {description: Created}
  /api/v1/projects/{projectId}/tasks/{taskId}/comments/{commentId}:
    delete:
      operationId: deleteComment
      tags: [Comments]
      responses:
        "204": {description: No Content}
  /api/v1/webhooks:
    get:
      operationId: listWebhooks
      tags: [Webhooks]
      responses:
        "200": {description: OK}
    post:
      operationId: createWebhook
      tags: [Webhooks]
      requestBody:
        required: true
        content:
          application/json:
            schema: {type: object}
      responses:
        "201": {description: Created}
  /api/v1/webhooks/{webhookId}:
    get:
      operationId: getWebhook
      tags: [Webhooks]
      responses:
        "200": {description: OK}
    put:
      operationId: updateWebhook
      tags: [Webhooks]
      requestBody:
        required: true
        content:
          application/json:
            schema: {type: object}
      responses:
        "200": {description: OK}
    delete:
      operationId: deleteWebhook
      tags: [Webhooks]
      responses:
        "204": {description: No Content}
  /api/v1/webhooks/{webhookId}/ping:
    post:
      operationId: pingWebhook
      tags: [Webhooks]
      responses:
        "200": {description: OK}
`;

describe("generateFlaskRoutes", () => {
  const result = generateFlaskRoutes(BOILERPLATE_SPEC);

  describe("routes.py", () => {
    it("defines ops_bp and api_bp blueprints", () => {
      expect(result.routes).toContain('ops_bp = Blueprint("ops"');
      expect(result.routes).toContain('api_bp = Blueprint("api"');
    });

    it("includes the health check on ops_bp", () => {
      expect(result.routes).toContain("@ops_bp.route(\"/health\"");
      expect(result.routes).toContain("def health_check():");
    });

    it("uses the spec title in the health check response", () => {
      expect(result.routes).toContain("Platform Management API");
    });

    it("generates routes for all resource groups", () => {
      // Users
      expect(result.routes).toContain('"/users"');
      expect(result.routes).toContain('"/users/<user_id>"');
      // Organizations
      expect(result.routes).toContain('"/organizations"');
      expect(result.routes).toContain('"/organizations/<org_id>"');
      // Projects
      expect(result.routes).toContain('"/projects"');
      expect(result.routes).toContain('"/projects/<project_id>"');
      // Tasks (nested under projects)
      expect(result.routes).toContain('"/projects/<project_id>/tasks"');
      expect(result.routes).toContain('"/projects/<project_id>/tasks/<task_id>"');
      // Comments (nested under tasks)
      expect(result.routes).toContain('"/projects/<project_id>/tasks/<task_id>/comments"');
      // Webhooks
      expect(result.routes).toContain('"/webhooks"');
      expect(result.routes).toContain('"/webhooks/<webhook_id>"');
    });

    it("generates list endpoints returning paginated JSON", () => {
      expect(result.routes).toContain('"users"');
      expect(result.routes).toContain('"total"');
      expect(result.routes).toContain('"limit"');
      expect(result.routes).toContain('"offset"');
    });

    it("generates create endpoints returning 201", () => {
      expect(result.routes).toContain("return jsonify(item), 201");
    });

    it("generates get endpoints returning stubs for missing items (not 404)", () => {
      // Stub APIs return generated objects so smoke tests pass against empty stores
      expect(result.routes).toContain("# Return stub so smoke/contract tests pass");
      expect(result.routes).not.toMatch(/if not item:\s*\n\s*return jsonify\(\{"error": "not_found"/);
    });

    it("generates delete endpoints returning 204", () => {
      expect(result.routes).toContain('return "", 204');
    });

    it("generates update endpoints that merge request body", () => {
      expect(result.routes).toContain("item.update(data)");
      expect(result.routes).toContain('"updatedAt"');
    });

    it("does not enforce parent existence in stub mode (empty stores)", () => {
      // Stub APIs skip parent validation so nested routes always return 2xx
      expect(result.routes).not.toContain("if project_id not in projects_store:");
    });

    it("filters nested resource lists by parent ID", () => {
      // Tasks listed under a project should filter by projectId
      expect(result.routes).toContain('v.get("projectId")');
    });

    it("generates the webhook ping action endpoint", () => {
      expect(result.routes).toContain('"/webhooks/<webhook_id>/ping"');
      expect(result.routes).toContain('"action"');
      expect(result.routes).toContain('"ping"');
    });

    it("generates the members list endpoint under organizations", () => {
      expect(result.routes).toContain('"/organizations/<org_id>/members"');
    });

    it("does not contain marshmallow imports", () => {
      expect(result.routes).not.toContain("marshmallow");
      expect(result.routes).not.toContain("ValidationError");
    });

    it("imports get_store from app.models", () => {
      expect(result.routes).toContain("from app.models import get_store");
    });

    it("uses uuid for ID generation", () => {
      expect(result.routes).toContain("import uuid");
      expect(result.routes).toContain("uuid.uuid4()");
    });

    it("has unique function names (no duplicates)", () => {
      const funcNames = result.routes.match(/^def (\w+)\(/gm) || [];
      const unique = new Set(funcNames);
      expect(funcNames.length).toBe(unique.size);
    });
  });

  describe("models.py", () => {
    it("defines get_store function", () => {
      expect(result.models).toContain("def get_store(resource");
    });

    it("defines reset_stores function", () => {
      expect(result.models).toContain("def reset_stores():");
    });

    it("uses a module-level _stores dict", () => {
      expect(result.models).toContain("_stores:");
    });

    it("does not contain marshmallow or domain classes", () => {
      expect(result.models).not.toContain("marshmallow");
      expect(result.models).not.toContain("class Portfolio");
      expect(result.models).not.toContain("class Trade");
    });
  });

  describe("__init__.py", () => {
    it("imports both blueprints from routes", () => {
      expect(result.initPy).toContain("from app.routes import api_bp, ops_bp");
    });

    it("uses API_BASE_PATH to prefix ops routes at runtime", () => {
      expect(result.initPy).toContain('os.environ.get("API_BASE_PATH", "")');
      expect(result.initPy).toContain("app.register_blueprint(ops_bp, url_prefix=ops_prefix)");
    });

    it("combines API_BASE_PATH with detected /api/v1 prefix for api routes", () => {
      expect(result.initPy).toContain('spec_prefix = "/api/v1"');
      expect(result.initPy).toContain('api_prefix = f"{base_path}{spec_prefix}" if spec_prefix else base_path');
      expect(result.initPy).toContain("app.register_blueprint(api_bp, url_prefix=api_prefix)");
    });

    it("uses CORS", () => {
      expect(result.initPy).toContain("CORS(app)");
    });
  });

  describe("prefix detection", () => {
    it("detects /api/v2 prefix", () => {
      const spec = `
openapi: "3.0.3"
info:
  title: Test API
  version: "1.0.0"
paths:
  /health:
    get:
      operationId: healthCheck
      tags: [Ops]
  /api/v2/items:
    get:
      operationId: listItems
      tags: [Items]
    post:
      operationId: createItem
      tags: [Items]
  /api/v2/items/{itemId}:
    get:
      operationId: getItem
      tags: [Items]
`;
      const out = generateFlaskRoutes(spec);
      expect(out.initPy).toContain('spec_prefix = "/api/v2"');
      expect(out.routes).toContain('"/items"');
      expect(out.routes).toContain('"/items/<item_id>"');
    });

    it("handles no common prefix", () => {
      const spec = `
openapi: "3.0.3"
info:
  title: Flat API
  version: "1.0.0"
paths:
  /health:
    get:
      operationId: healthCheck
      tags: [Ops]
  /items:
    get:
      operationId: listItems
      tags: [Items]
  /orders:
    get:
      operationId: listOrders
      tags: [Orders]
`;
      const out = generateFlaskRoutes(spec);
      // No detected spec prefix; API routes use only API_BASE_PATH when provided.
      expect(out.initPy).toContain('spec_prefix = ""');
      expect(out.initPy).toContain("app.register_blueprint(api_bp)");
    });
  });

  describe("edge cases", () => {
    it("handles spec with no paths gracefully", () => {
      const spec = `
openapi: "3.0.3"
info:
  title: Empty API
  version: "1.0.0"
paths: {}
`;
      const out = generateFlaskRoutes(spec);
      expect(out.routes).toContain("health_check");
      expect(out.models).toContain("get_store");
    });

    it("generates fallback function name when operationId is missing", () => {
      const spec = `
openapi: "3.0.3"
info:
  title: No OpId API
  version: "1.0.0"
paths:
  /api/v1/things:
    get:
      tags: [Things]
`;
      const out = generateFlaskRoutes(spec);
      // Should generate a function name from method + path
      expect(out.routes).toContain("def ");
      expect(out.routes).toContain("/things");
    });

    it("handles inline YAML maps", () => {
      const spec = `
openapi: "3.0.3"
info: {title: Inline API, version: "1.0.0"}
paths:
  /api/v1/widgets:
    get: {operationId: listWidgets, tags: [Widgets]}
    post: {operationId: createWidget, tags: [Widgets], requestBody: {required: true, content: {application/json: {schema: {type: object}}}}}
`;
      const out = generateFlaskRoutes(spec);
      expect(out.routes).toContain("def list_widgets");
      expect(out.routes).toContain("def create_widget");
    });

    it("handles specs with YAML comments", () => {
      const spec = `
# This is a comment
openapi: "3.0.3"
info:
  title: Commented API # inline comment
  version: "1.0.0"
paths:
  /api/v1/gadgets:
    get:
      operationId: listGadgets
      tags:
        - Gadgets # a tag
`;
      const out = generateFlaskRoutes(spec);
      expect(out.routes).toContain("def list_gadgets");
    });
  });

  describe("Python identifier safety", () => {
    it("handles operationId starting with a digit", () => {
      const spec = `
openapi: "3.0.3"
info: {title: Test, version: "1.0.0"}
paths:
  /api/v1/items:
    get: {operationId: 2ndListItems, tags: [Items]}
`;
      const out = generateFlaskRoutes(spec);
      // Should not start with a digit
      expect(out.routes).toMatch(/def fn_2nd_list_items/);
    });

    it("handles operationId that is a Python keyword", () => {
      const spec = `
openapi: "3.0.3"
info: {title: Test, version: "1.0.0"}
paths:
  /api/v1/things:
    get: {operationId: "return", tags: [Things]}
`;
      const out = generateFlaskRoutes(spec);
      // "return" is a Python keyword -- should append _handler
      expect(out.routes).toContain("def return_handler");
    });
  });

  describe("stub responses include parent IDs for nested resources", () => {
    it("includes projectId in task GET stub", () => {
      // The GET stub for a task should include the parent projectId
      expect(result.routes).toContain('"projectId"');
    });
  });

  describe("delete is idempotent", () => {
    it("uses store.pop instead of 404 for missing items", () => {
      expect(result.routes).toContain("store.pop(");
      expect(result.routes).not.toMatch(/del store\[/);
    });
  });

  describe("full round-trip count", () => {
    it("generates route functions for all spec operations", () => {
      const funcDefs = result.routes.match(/^def \w+\(/gm) || [];
      // health_check + all API operations
      expect(funcDefs.length).toBeGreaterThanOrEqual(25);
    });
  });
});
