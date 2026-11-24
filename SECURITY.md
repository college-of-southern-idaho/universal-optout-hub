# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report them privately via **GitHub Security Advisories** — on this repository, go to
the **Security** tab → **Report a vulnerability** (GitHub's private vulnerability
reporting). If that is unavailable, email the maintainers at the address listed in the
repository's `NOTICE`/README (maintainers: replace this with a monitored security
contact before publishing).

Please include:

- a description of the issue and its impact,
- steps to reproduce (a proof-of-concept if you have one),
- affected version/commit, and
- any suggested remediation.

You can expect an acknowledgement within a few business days and a status update as we
investigate. We ask that you give us a reasonable opportunity to remediate before any
public disclosure, and we're happy to credit you in the advisory if you'd like.

## Scope

This project is a **self-hosted** application; each deployment operates its own
instance, database, and credentials. Security-relevant areas include: authentication
and session handling, the role-based access model, the encrypted credential store, the
machine-authenticated consent-check API, and the signature-verified inbound webhooks.

The design intentionally **fails closed** (when consent state can't be determined, it
withholds) and keeps platform credentials encrypted at rest. See
[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) for the project's own security review and
[`DESIGN.md`](DESIGN.md) for the threat-relevant architecture.

## Supported versions

This project is pre-1.0 and under active development; security fixes are applied to the
`main` branch. Operators should track `main` (or tagged releases once published) and
apply updates promptly.

## Operator responsibilities

A secure deployment also depends on the operator:

- Set a strong, unique `APP_SECRET` (the app refuses weak/dev defaults in production)
  and keep it — and `DATABASE_URL` — out of the repository (use env / mounted secrets).
- Terminate TLS at the reverse proxy, enforce the HTTP→HTTPS redirect, and restrict or
  token-guard `/metrics`.
- Keep PostgreSQL and the Node runtime patched; restrict network access to both.
- Rotate credentials and the encryption key per
  [`RUNBOOK-key-and-credential-rotation.md`](RUNBOOK-key-and-credential-rotation.md).
