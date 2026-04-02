# Frontend Architecture

React + Vite SPA served by the Cloudflare Worker as static assets from `public/` in production, with a single-origin Vite + Cloudflare worker workflow in local development. Entry point is `src/main.tsx`.

---

## Directory Structure

| Directory / File | Description |
|---|---|
| `src/main.tsx` | App entry: router setup, lazy page imports, Suspense/ErrorBoundary wiring |
| `src/styles.css` | Single import file that pulls in all 20 CSS module files in order |
| `src/styles/` | 20 scoped CSS files; `tokens.css` is the design token source of truth |
| `src/components/` | 24 shared UI components used across pages |
| `src/pages/` | 6 route-level page components (one per route) |
| `src/hooks/` | 5 custom React hooks |
| `src/lib/` | 13 non-React utility modules: types, route config, API helpers, domain data |

---

## CSS Architecture

### Import chain

`main.tsx` imports `./styles.css`, which is the single aggregation file:

```css
@import "./styles/reset.css";
@import "./styles/tokens.css";
@import "./styles/layout.css";
/* ... 17 more imports in order */
```

All styles are global (no CSS Modules). Class names follow a BEM-like convention.

### tokens.css — single source of truth

All design values are defined as CSS custom properties on `:root` in `styles/tokens.css`. Every other file consumes them via `var(--token-name)`. Never hardcode colors, spacing, or radii outside `tokens.css`.

Token categories:

| Category | Examples |
|---|---|
| Core palette | `--bg`, `--surface`, `--text`, `--accent` (`#f97316`) |
| Neutral scale | `--neutral-50` through `--neutral-900` |
| Semantic colors | `--danger-bg/text/border`, `--success-bg/text`, `--warning-bg/text/border`, `--info-bg/text/border` |
| Spacing (4px grid) | `--space-1` (4px) through `--space-12` (48px) |
| Typography | `--font-sans`, `--font-mono`, `--text-xs` (10px) through `--text-3xl` (24px) |
| Shadows | `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-focus` |
| Radii | `--radius` (10px), `--radius-sm` (4px), `--micro-radius` (6px), `--radius-full` |
| Transitions | `--transition-fast` (0.15s), `--transition-normal` (0.2s), `--transition-slow` (0.3s) |

### CSS module file list

| File | Scope |
|---|---|
| `reset.css` | Browser default normalization |
| `tokens.css` | Design tokens (`:root` custom properties) |
| `layout.css` | App shell: `.app`, `.header`, `.header-nav`, `.main` |
| `meta-bar.css` | Toolbar/filter bar above tables |
| `services-table.css` | Deployed services table and row styles |
| `modals.css` | Modal overlay and dialog chrome |
| `badges.css` | Status/runtime/domain badge chips |
| `buttons.css` | `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-sm` |
| `status.css` | `.status-card` variants, `.error-boundary-fallback`, banners |
| `forms.css` | Input, select, label, fieldset, form layout |
| `industry-selector.css` | Industry grid picker on Provision page |
| `spec-selector.css` | Spec search/filter dropdown |
| `provision.css` | Provision page layout and form sections |
| `provision-stages.css` | SSE stage tracker progress UI |
| `settings.css` | Settings page team registry table and forms |
| `responsive.css` | Media query breakpoints (sm: 640px, md: 768px, lg: 1024px) |
| `utilities.css` | Single-purpose utility classes (`.sr-only`, `.truncate`, etc.) |
| `toast.css` | Toast notification stack and animations |
| `skeleton.css` | Loading skeleton shimmer animation |
| `breadcrumbs.css` | Breadcrumb nav trail |

### Supporting-Text Primitives

Two standardized classes for modal helper text:

| Class | Location | Purpose |
|-------|----------|---------|
| `.modal-subtitle` | `Modal.Header` | Modal-level explanatory copy (via `subtitle` prop) |
| `.modal-hint` | `Modal.Body` | Field-level helper text for individual inputs |

**Usage:**
```tsx
<Modal.Header
  title="Register New Team"
  subtitle="Modal-level context that applies to the entire form."
/>
<Modal.Body>
  <p className="modal-hint">Field-specific guidance for this input.</p>
</Modal.Body>
```

### Design System Validator

The validator enforces token usage and prevents hardcoded values in changed frontend files.

**What it checks:**
- Hardcoded `font-size: <n>px` → requires `var(--text-*)` token
- Hardcoded `color: #rrggbb` → requires semantic token like `var(--text)`, `var(--muted)`, `var(--accent)`
- Inline styles with pixel values
- Banned legacy class patterns

**Exception syntax:**
```css
/* design-system-exception: third-party override required for library compatibility */
font-size: 13px;
```
```tsx
{/* design-system-exception: animation timing requires exact ms value */}
```

**Commands:**
```bash
npm run validate:design-system      # Check changed files
npm run validate:design-system:all  # Check all frontend files
npm run test:design-system          # Run validator tests
```

**Automation:**
- Pre-commit hook runs on staged frontend files
- OpenCode Stop/SubagentStop uses identical rules
- Validator location: `scripts/validate-design-system.mjs`

---

## Component Catalog

### Shared components (`src/components/`)

| Component | Key Props | Usage |
|---|---|---|
| `Layout` | _(none — wraps `<Outlet>`)_ | Root shell: header, nav, breadcrumbs, `ToastProvider`. Wraps all routes via React Router `<Route element={<Layout />}>`. |
| `StatusCard` | `variant: "loading"\|"empty"\|"error"\|"warning"\|"success"\|"in-progress"`, `title`, `description?`, `action?`, `secondaryAction?`, `className?` | General-purpose state card. Sets `role="alert"` for error/warning, `role="status"` for loading/in-progress. |
| `EmptyState` | `title?`, `description?`, `action?` | Thin wrapper over `StatusCard` with `variant="empty"`. Default title: "Nothing here yet". |
| `InProgressBar` | `title?`, `description?` | Thin wrapper over `StatusCard` with `variant="in-progress"`. Shows animated progress bar. Default title: "Operation in progress". |
| `ErrorBanner` | `message`, `onDismiss?`, `onRetry?` | Inline error strip with optional Retry/Dismiss buttons. Returns `null` when `message` is empty. |
| `WarningBanner` | `message`, `onDismiss?`, `action?` | Inline warning strip with optional action and dismiss. Returns `null` when `message` is empty. |
| `SuccessBanner` | `message`, `onDismiss?` | Inline success strip with optional dismiss. Returns `null` when `message` is empty. |
| `ErrorBoundary` | `children`, `fallback?` | Class component; catches render errors and shows a reload/home fallback. |
| `RouteErrorBoundary` | `children` | Wraps `ErrorBoundary` with `key={location.pathname}` so it resets on navigation. Used in `main.tsx` around every route. |
| `Skeleton` | `variant?: "text"\|"rect"\|"circle"\|"table-row"`, `width?`, `height?`, `count?`, `columns?`, `className?` | Loading placeholder. `variant="table-row"` renders `<tr>` elements; all others render `<span>`. |
| `Breadcrumbs` | _(none — reads `useLocation`)_ | Renders breadcrumb trail from `lib/routes.ts` config. Hidden when trail has one or fewer items. |
| `PageHeader` | `title`, `description?` | `<h1>` + optional description paragraph. Used at the top of each page. |
| `ConfirmDialog` | `open`, `title`, `description`, `confirmLabel?`, `cancelLabel?`, `variant?: "danger"\|"default"`, `onConfirm`, `onCancel` | Native `<dialog>` element. Focuses confirm button on open. Closes on Escape or backdrop click. |
| `ToastContainer` | _(none — reads context)_ | Renders toast stack into `document.body` via `createPortal`. Consumed from `useToast` context. |

### Page-specific components

These are used only within one page and are not intended for reuse:

| Component | Used by |
|---|---|
| `IndustrySelector` | `ProvisionPage` |
| `SpecSelector` | `ProvisionPage` |
| `ProvisionLaunchPanel` | `ProvisionPage` |
| `ProvisionStageTracker` | `ProvisionPage` |
| `GraphReviewSummary` | `ProvisionPage` |
| `CatalogTeamFilter` | `CatalogPage` |
| `ChaosConfigInput` | `CatalogPage` |
| `ChaosConfigModal` | `CatalogPage` |
| `RegisterTeamModal` | `SettingsPage` |
| `TeardownStepTracker` | `RecoveryPage` |
| `HeaderDangerXIcon` | Internal icon utility |

---

## Routing

### Setup (`src/main.tsx`)

All pages are lazy-loaded via `React.lazy`. The entire tree is wrapped in a single `<Suspense>` with a skeleton fallback. Each route is individually wrapped in `<RouteErrorBoundary>`.

```tsx
const CatalogPage = lazy(() =>
  import("./pages/CatalogPage").then(m => ({ default: m.CatalogPage }))
);

<BrowserRouter>
  <Suspense fallback={<div className="page-loading">...</div>}>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<RouteErrorBoundary><CatalogPage /></RouteErrorBoundary>} />
        <Route path="provision" element={<RouteErrorBoundary><ProvisionPage /></RouteErrorBoundary>} />
        {/* ... */}
      </Route>
    </Routes>
  </Suspense>
</BrowserRouter>
```

### Route registry (`src/lib/routes.ts`)

Routes are declared in a `routes` record with metadata used by `Layout` (nav rendering) and `Breadcrumbs` (trail construction):

```ts
export const routes: Record<string, RouteConfig> = {
  services:  { path: "/",          label: "Services",  group: "operations", ... },
  recovery:  { path: "/recovery",  label: "Recovery",  group: "operations", parent: "services", ... },
  provision: { path: "/provision", label: "Provision", group: "operations", parent: "services", ... },
  settings:  { path: "/settings",  label: "Settings",  group: "admin",      parent: "services", ... },
  docs:      { path: "/docs",      label: "Docs",      group: "admin",      parent: "services", ... },
};
```

`group: "operations"` routes appear in the primary nav; `group: "admin"` routes appear after the separator. `parent` drives breadcrumb ancestry.

### Suspense fallback

The fallback renders two `<Skeleton>` elements (one `text`, one `rect`) inside a `.page-loading` div. This is the only loading state shown during initial route chunk load.

---

## Patterns

### Data fetching

Pages fetch data in `useEffect` with a local `loading` / `error` / `data` state pattern:

```tsx
const [data, setData] = useState<Thing[] | null>(null);
const [loading, setLoading] = useState(true);
const [error, setError] = useState<string | null>(null);

useEffect(() => {
  let cancelled = false;
  setLoading(true);
  fetch("/api/things")
    .then(r => r.json())
    .then(d => { if (!cancelled) setData(d); })
    .catch(e => { if (!cancelled) setError(e.message); })
    .finally(() => { if (!cancelled) setLoading(false); });
  return () => { cancelled = true; };
}, []);
```

The `cancelled` flag prevents state updates after unmount.

### Loading states

- **Table rows**: `<Skeleton variant="table-row" count={5} columns={6} />` inside `<tbody>` while fetching.
- **Full-page**: `<StatusCard variant="loading" title="Loading..." />` for non-table pages.
- **Route transition**: `<Suspense>` fallback in `main.tsx` (skeleton pair).

### Empty states

Use `<EmptyState>` when a fetch succeeds but returns zero items:

```tsx
{!loading && data.length === 0 && (
  <EmptyState
    title="No services found"
    description="Provision a service to get started."
    action={{ label: "Provision", onClick: () => navigate("/provision") }}
  />
)}
```

### Error handling

Three layers:

1. **Inline fetch errors**: `<ErrorBanner message={error} onRetry={refetch} onDismiss={() => setError(null)} />` rendered above the page content.
2. **Route-level render errors**: `<RouteErrorBoundary>` in `main.tsx` catches uncaught render exceptions and shows a reload/home fallback.
3. **Toast notifications**: `useToast().addToast(message, { type: "error" })` for transient feedback after mutations.

### Toast system

`ToastProvider` (mounted in `Layout`) exposes `addToast` / `dismissToast` via context. `useToast()` is the consumer hook. Toasts auto-dismiss after 5s (info/success) or 8s (error/warning). Maximum 5 toasts visible at once; oldest is evicted when the cap is exceeded.

```tsx
const { addToast } = useToast();
addToast("Teardown complete", { type: "success" });
addToast("Failed to fetch deployments", { type: "error", duration: 10000 });
```

---

## Adding a New Page

### Checklist

1. **Create the page file** at `src/pages/MyPage.tsx`. Export a named component:

   ```tsx
   export function MyPage() {
     return (
       <div>
         <PageHeader title="My Page" description="Optional description." />
         {/* page content */}
       </div>
     );
   }
   ```

2. **Register the route** in `src/lib/routes.ts`:

   ```ts
   mypage: {
     path: "/mypage",
     label: "My Page",
     title: "My Page",
     group: "operations",   // or "admin"
     description: "What this page does.",
     parent: "services",    // omit if top-level
   },
   ```

3. **Add the lazy import** in `src/main.tsx`:

   ```tsx
   const MyPage = lazy(() =>
     import("./pages/MyPage").then(m => ({ default: m.MyPage }))
   );
   ```

4. **Add the route** inside the `<Route element={<Layout />}>` block in `src/main.tsx`:

   ```tsx
   <Route
     path="mypage"
     element={<RouteErrorBoundary><MyPage /></RouteErrorBoundary>}
   />
   ```

5. **Add CSS** (if needed) in a new file `src/styles/mypage.css` and add an `@import` line to `src/styles.css`. Use `var(--token-name)` for all values.

6. **Verify nav rendering**: The route will appear in the header nav automatically based on its `group` value. No manual nav edits needed.

### What you get for free

- Breadcrumbs (if `parent` is set in route config)
- Route-level error boundary (from `RouteErrorBoundary` wrapper)
- Lazy chunk splitting (from `React.lazy`)
- Skeleton fallback during chunk load (from the root `<Suspense>`)
- Toast access via `useToast()` (from `ToastProvider` in `Layout`)
