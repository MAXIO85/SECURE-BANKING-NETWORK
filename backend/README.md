# Security verification API

The security verifier reads the Cisco running-configuration exports and project addressing/testing documents on each request. It does not connect to live routers or modify device configuration.

By default, the project root is `E:\Cisco Packet Tracer 9.0.0\secure banking network`. Override it with `SECURITY_PROJECT_DIR`, or set `SECURITY_CONFIG_DIR`, `SECURITY_DOCUMENTATION_DIR`, and `SECURITY_TEST_RESULTS_FILE` individually. The project root should contain `configurations`, `documentation`, and `Testing-Results`.

## Statuses

- **Verified** — the configuration checks and documented test evidence passed.
- **Not Configured** — no feature configuration was found in the supplied device exports.
- **Verification Failed** — configuration is partial, tests are incomplete, or required evidence is unavailable.

## Endpoints

- `GET /api/security` — perform and persist a fresh verification for all features.
- `POST /api/security/verify` — explicitly refresh and persist all feature results.
- `GET /api/security/:feature` — perform and persist a fresh verification, then return details for `vlan`, `acl`, `ssh`, `nat`, or `vpn`.
- `GET /api/security/history` — return the 20 most recent verification reports.

Runs and per-feature results are stored transactionally in SQLite at `backend/security-verifications.sqlite` by default. Override the location with `SECURITY_DATABASE_PATH`. The backend requires Node.js 22.13 or newer for the built-in SQLite module.

ACL, NAT, SSH, and VPN policy testing must be documented in the project test results before those features can be reported as verified. The current project documentation reports that their configuration/testing remains incomplete.
