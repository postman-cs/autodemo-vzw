# VZW Network Operations API

This repo-shaped service contains the Verizon network-facing APIs used in the partner demo.

It exposes:
- OAuth token exchange
- device location lookup
- Quality on Demand session reservation
- a deprecated legacy location endpoint (retained for repair-lane compatibility only)

The service is flagged for the Verizon partner demo with `vzw-partner-demo` metadata in `service.yaml` and `.env.example`.
