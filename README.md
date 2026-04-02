# Verizon (VZW) Deployment

## What This Directory Is

This directory is the first customer deployment and the reference implementation
for the platform. It contains the live Verizon-specific worker code, service
set, documentation, and supporting assets.

## Who Should Read This

Read this if you need to understand the live reference customer, trace how the
platform works in practice, or make customer-specific changes for Verizon.

## Canonical Child Docs

- Main worker: [`internal-catalog/README.md`](internal-catalog/README.md)
- Partner experience: [`partner-portal/`](partner-portal/)
- Fern docs config: [`fern/`](fern/)
- Service entrypoint: [`services/README.md`](services/README.md)
- Spec registry and dependencies: [`specs/`](specs/)
- Postman assets and config: [`postman/`](postman/)

## Directory Landmarks

- `internal-catalog/` is the operational center of the deployment.
- `services/` holds the generated service directories and service READMEs.
- `specs/` and `postman/` provide the catalog and workspace-side inputs.

## What A Coding Agent Should Open Next

Start with `internal-catalog/README.md` for the main worker.

## Notes

This is the live reference customer, not a neutral template. When live and
template docs disagree, prefer the customer-specific directory.
