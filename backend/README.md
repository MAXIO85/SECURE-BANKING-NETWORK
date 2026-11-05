# Security verification API

## Run the dashboard

Use Node.js 22.13 or newer. From this directory, run `npm start` and open
`http://localhost:3000`. The Express server serves the dashboard and its API
from the same origin. If opening the HTML files directly, the frontend also
connects to the default API port, `3000`; set `PORT` when starting the backend
only when using a frontend served from that same configured origin.
Cross-origin requests are restricted to the local dashboard and direct-file
origin by default. Set `API_ALLOWED_ORIGINS` to a comma-separated list of
additional trusted origins when hosting the frontend separately.

The inventory APIs parse the Cisco configuration exports and project addressing
and test documents on each request; they do not contain a separate, hard-coded
network inventory. `/api/network`, `/api/headquarters`, `/api/branch`,
`/api/vlans`, `/api/vlans/:id`, `/api/servers`, `/api/servers/:name`,
`/api/services`, and `/api/connectivity` return parsed project data, including
inter-site WAN endpoints and documented connectivity evidence. `/api/configuration`
and `/api/configuration/:feature` expose parsed ACL, NAT, VPN, SSH, and VLAN
configuration without returning raw device files or credential hashes.
Interface parsing remains internal to derive IP, gateway, VLAN, and WAN data;
raw device-interface lists are not exposed. Protocol-specific parsing and
verification are not exposed by the API. Missing required configuration files
return HTTP 503; unknown VLAN, server, and feature IDs return HTTP 404.

The website's Project Documentation page reads the original overview,
addressing-plan, and network-testing text files from the configured project
directories. `GET /api/documents` returns the available document contents and
download URLs; `GET /api/documents/:name` displays one allowlisted document,
and `?download=1` downloads it. Raw device configuration exports are not
published through these document endpoints.

The backend does not connect to Packet Tracer devices. Network status and test
results are therefore identified as exported configuration or documented
evidence, not a live device check. Server IPs come from the addressing plan;
server host configuration is not included in the exported files. The `.pkt`
simulation is not queried by the website. `/api/health` checks both the API
process and its SQLite verification database.

The security verifier reads the Cisco running-configuration exports and project addressing/testing documents on each request. It does not connect to live routers or modify device configuration.

By default, the project root is `E:\Cisco Packet Tracer 9.0.0\secure banking network`. Override it with `SECURITY_PROJECT_DIR`, or set `SECURITY_CONFIG_DIR`, `SECURITY_DOCUMENTATION_DIR`, and `SECURITY_TEST_RESULTS_FILE` individually. The project root should contain `configurations`, `documentation`, and `Testing-Results`.

## Statuses

- **Verified** — the configuration checks and documented test evidence passed.
- **Not Configured** — no feature configuration was found in the supplied device exports.
- **Verification Failed** — configuration is partial, tests are incomplete, or required evidence is unavailable.

For VLANs, ACLs, SSH, NAT, and VPN, **Verified** requires both feature-specific
configuration checks and explicit successful test evidence in
`NETWORK-TESTING-RESULTS.txt`. Partial or inconsistent configuration, or
missing test evidence for a configured feature, is **Verification Failed**.
**Not Configured** is used only when the complete supplied device exports
contain no configuration for that feature. The API does not claim that a
configuration was applied to live devices.

## Endpoints

- `GET /api/security` — perform and persist a fresh verification for all features.
- `POST /api/security/verify` — explicitly refresh and persist all feature results.
- `GET /api/security/:feature` — perform and persist a fresh verification, then return details for `vlan`, `acl`, `ssh`, `nat`, or `vpn`.
- `GET /api/security/history` — return the 20 most recent verification reports.

Runs and per-feature results are stored transactionally in SQLite at `backend/security-verifications.sqlite` by default. Override the location with `SECURITY_DATABASE_PATH`. The backend requires Node.js 22.13 or newer for the built-in SQLite module.

ACL, NAT, SSH, and VPN policy testing must be documented in the project test results before those features can be reported as verified. The current project documentation reports that their configuration/testing remains incomplete.
