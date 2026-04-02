#!/usr/bin/env bash
# Validate a customer config YAML for required fields and valid values.
# Usage: ./scripts/validate-config.sh <path-to-config.yaml>
#   e.g., ./scripts/validate-config.sh customers/fiserv/config.yaml
set -euo pipefail

CONFIG="${1:-}"
if [[ -z "$CONFIG" ]]; then
  echo "Usage: $0 <path-to-config.yaml>"
  exit 1
fi

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: File not found: ${CONFIG}"
  exit 1
fi

python3 -c "
import yaml, re, sys

with open('${CONFIG}') as f:
    data = yaml.safe_load(f)

errors = []
warnings = []

# Required top-level fields
for field in ['slug', 'customer_name']:
    if not data.get(field):
        errors.append(f'Missing required field: {field}')

# Platform
p = data.get('platform', {})
for field in ['name', 'subtitle', 'jira_prefix', 'iam_role_prefix']:
    if not p.get(field):
        errors.append(f'Missing required field: platform.{field}')

# Branding
b = data.get('branding', {})
for field in ['primary', 'primary_hover', 'logo', 'favicon', 'hero_image']:
    if not b.get(field):
        errors.append(f'Missing required field: branding.{field}')

# Validate hex colors
hex_re = re.compile(r'^#[0-9a-fA-F]{3,8}\$')
color_fields = ['primary', 'primary_hover', 'accent', 'bg', 'surface', 'border',
                'text', 'text_secondary', 'postman_orange', 'success', 'warning', 'error']
for field in color_fields:
    val = b.get(field, '')
    if val and not hex_re.match(val):
        errors.append(f'Invalid hex color for branding.{field}: {val}')

# Contact
c = data.get('contact', {})
for field in ['email_domain', 'email_from', 'email_signature', 'support_label']:
    if not c.get(field):
        errors.append(f'Missing required field: contact.{field}')

# Domains
domains = data.get('domains', [])
if not domains:
    errors.append('Missing required field: domains (at least one entry)')
for i, d in enumerate(domains):
    for field in ['value', 'label', 'code', 'governance_group']:
        if not d.get(field):
            errors.append(f'domains[{i}] missing required field: {field}')

# AWS accounts
accounts = data.get('aws_accounts', [])
if not accounts:
    warnings.append('No aws_accounts defined (form dropdown will be empty)')
for i, a in enumerate(accounts):
    for field in ['id', 'label', 'product_code', 'service_name']:
        if not a.get(field):
            errors.append(f'aws_accounts[{i}] missing required field: {field}')

# Templates
templates = data.get('templates', [])
if not templates:
    errors.append('Missing required field: templates (at least one entry)')
has_enabled = any(t.get('enabled') for t in templates)
if not has_enabled:
    warnings.append('No template has enabled: true (no Select button will be active)')
valid_runtimes = {"lambda", "ecs_service", "k8s_roadmap"}
for i, t in enumerate(templates):
    if not t.get('id'):
        warnings.append(f'templates[{i}] missing id (will be auto-derived from title)')
    runtime = t.get('runtime')
    if runtime and runtime not in valid_runtimes:
        errors.append(f'templates[{i}] runtime must be one of {sorted(valid_runtimes)}')
    if t.get('provisioning_enabled') is False and t.get('enabled'):
        warnings.append(f'templates[{i}] has enabled=true but provisioning_enabled=false')

# Form defaults
fd = data.get('form_defaults', {})
for field in ['project_name', 'application_id', 'form_title', 'form_subtitle']:
    if not fd.get(field):
        errors.append(f'Missing required field: form_defaults.{field}')

# Specs
specs = data.get('specs', [])
if not specs:
    warnings.append('No specs defined (spec dropdown will be empty)')

# Sidebar
sb = data.get('sidebar', {})
for section in ['navigation', 'tools', 'support']:
    if not sb.get(section):
        warnings.append(f'sidebar.{section} is empty')

# Backend
be = data.get('backend', {})
for field in ['github_org', 'user_agent', 'boilerplate_url', 'git_committer_name', 'git_committer_email']:
    if not be.get(field):
        errors.append(f'Missing required field: backend.{field}')
runtime_defaults = be.get('runtime_defaults', {})
default_runtime = runtime_defaults.get('default_runtime')
if default_runtime and default_runtime not in ['lambda', 'ecs_service']:
    errors.append('backend.runtime_defaults.default_runtime must be lambda or ecs_service')

# Report
if warnings:
    print(f'Warnings ({len(warnings)}):')
    for w in warnings:
        print(f'  WARN: {w}')

if errors:
    print(f'Errors ({len(errors)}):')
    for e in errors:
        print(f'  ERROR: {e}', file=sys.stderr)
    print(f'FAILED: {len(errors)} errors found in {\"${CONFIG}\"}')
    sys.exit(1)
else:
    slug = data.get('slug', '?')
    name = data.get('platform', {}).get('name', '?')
    print(f'PASSED: {\"${CONFIG}\"}')
    print(f'  Customer: {data.get(\"customer_name\", \"?\")} ({slug})')
    print(f'  Platform: {name}')
    print(f'  Templates: {len(templates)}, Domains: {len(domains)}, AWS Accounts: {len(accounts)}')
"
