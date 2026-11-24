# Runbook — PostgreSQL backup & disaster recovery

Backup and recovery for the Consent Hub. All durable state lives in **one
PostgreSQL database**, so backup/DR is almost entirely "protect and restore that
database" — plus **one external secret** without which a restore is incomplete.
(PRODUCTION-READINESS Â§2.)

---

## ⚠️ Read this first: the database is not enough by itself

Stored **platform credentials** (Twilio, SendGrid, etc.) are encrypted at rest
with **AES-256-GCM under a key derived from `APP_SECRET`** (see
[RUNBOOK-key-and-credential-rotation.md](RUNBOOK-key-and-credential-rotation.md)).
A database backup contains only the *ciphertext*. So:

- **Back up `APP_SECRET` too** — securely, and **separately** from the DB dump (a
  leaked dump must not also leak the key). Store it where you store other break-glass
  secrets (a secrets manager / sealed vault), not next to the backups.
- **A restore with the wrong/missing `APP_SECRET` cannot decrypt platform
  credentials.** Everything else survives (consent history, audit log, users,
  config) — but you'd have to **re-enter every platform's credentials** by hand.
- Not affected by `APP_SECRET`: user passwords (scrypt, one-way), service API-key
  hashes (sha256) — these restore fine. Sessions won't (users just re-login).

**Rule of thumb:** a backup is only valid if you have captured **both** the DB dump
**and** the matching `APP_SECRET` (and `APP_SECRET_OLD` if a rotation is in flight).

---

## What's in the database (data classes for risk assessment)

- Contact **identities** (phone/email) and **consent/opt-out history** (`consent_events`, `consent_states`, `hub_writes`, `approval_*`, `reconcile_alerts`) — append-only, RESTRICT FKs.
- **Audit log** (`audit_log`) — operational activity + admin actions; pruned on a configurable window (compliance-relevant actions kept indefinitely). The authoritative immutable records are the consent event history, evidence, and approvals above.
- **Operator accounts** (username, scrypt hash, role) and **sessions**.
- **Encrypted platform credentials** + **service API-key hashes** + app **config**.

Backups therefore contain **PII** (contact identifiers) and encrypted secrets —
treat them as sensitive: encrypt at rest, restrict access, log retrievals.

---

## Strategy

- **Primary — nightly logical dump** (`pg_dump` custom format). Simple, portable,
  right-sized for a single database. Follow **3-2-1** (≥3 copies, 2 media, 1
  off-site/off-host), each copy encrypted.
- **Optional — PITR** (WAL archiving + `pg_basebackup`) if you need a tighter RPO
  than a night, or once you run HA. Not required at current scale.
- **Targets (set per deployment):** suggested **RPO ≤ 24 h** (nightly; tighten with WAL),
  **RTO ≤ a few hours**. Because opt-out is idempotent and the reconciler re-syncs
  from the platforms, a small RPO gap is low-harm, but audit completeness argues for
  frequent backups.
- **Retention:** keep enough history to recover from *late-detected* corruption or
  ransomware — e.g. **daily for 30 days + monthly for 12 months**. (This is *backup*
  retention — distinct from the app's *data* retention windows in ADR-0004 §7.)

---

## Take a backup

Custom-format, compressed dump (works on any host with the Postgres client tools):

```bash
pg_dump -Fc --no-owner \
  -d "postgresql://<user>:<pass>@<host>:5432/optout_hub" \
  -f "optout_hub_$(date +%Y%m%d_%H%M%S).dump"
```

**Windows (your-hub.example.edu)** — `pg_dump.exe` ships with PostgreSQL; schedule a script via
**Task Scheduler**. Example PowerShell:

```powershell
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$out   = "D:\backups\optout_hub_$stamp.dump"
& "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -Fc --no-owner `
  -d "postgresql://<user>:<pass>@localhost:5432/optout_hub" -f $out
# then: copy $out to off-host encrypted storage, and prune copies older than retention
```

Store the dump **off the database host**, **encrypted** (backup tool, or `gpg`/BitLocker/
object-store SSE), with restricted access. **Separately**, confirm the current
`APP_SECRET` is captured in your secrets vault.

---

## Restore

1. **Provision a target database** (a scratch DB for a drill, or the rebuilt prod DB):
   ```bash
   createdb optout_hub_restore
   pg_restore --no-owner --clean --if-exists \
     -d "postgresql://<user>:<pass>@<host>:5432/optout_hub_restore" \
     optout_hub_YYYYMMDD.dump
   ```
2. **Bring the schema current** (idempotent, rerun-safe — harmless if already latest):
   ```bash
   DATABASE_URL="postgresql://<user>:<pass>@<host>:5432/optout_hub_restore" npm run migrate
   ```
3. **Restore `APP_SECRET`** — set the *same* `APP_SECRET` (and `APP_SECRET_OLD` if a
   rotation was mid-flight) the data was encrypted under, or the platform credentials
   won't decrypt.
4. **Point the app at the restored DB** (`DATABASE_URL`) and restart.
5. **Verify** — see the drill below.

If `APP_SECRET` is **lost**: the app still runs and all consent/audit data is intact;
re-enter each service's credentials via the console (Service Config → credentials),
then **Test connection** per system.

---

## Tested-restore drill (do this on a schedule — HECVAT expects it)

Backups you've never restored are a hope, not a plan. Quarterly (at least):

1. Restore the latest dump into a **scratch** database (steps 1–4 above, using a
   throwaway DB name and the real `APP_SECRET`).
2. **Row-count sanity** vs. production, e.g.:
   ```sql
   SELECT
     (SELECT count(*) FROM identities)      AS identities,
     (SELECT count(*) FROM consent_events)  AS events,
     (SELECT count(*) FROM audit_log)       AS audit;
   ```
3. **App boots** against it — hit `/readyz` (expect `{"status":"ready"}`).
4. **Credentials decrypt** — run **Test connection** on one live system (proves
   `APP_SECRET` + the encrypted credential store round-tripped).
5. Record the drill date/result. Drop the scratch DB.

---

## DR scenarios

| Scenario | Action |
|---|---|
| **Database host lost** | Stand up a new PostgreSQL host, restore the latest dump, restore `APP_SECRET`, repoint `DATABASE_URL`, restart, verify. |
| **Data corruption / bad migration** | Restore the last known-good dump into a fresh DB, verify, cut over. Migrations are forward-only — restore rather than "un-migrate." |
| **Ransomware / tampering** | Restore from an **off-host, immutable/older** copy predating the compromise (why retention keeps monthly copies). Rotate `APP_SECRET` and all platform credentials afterward. |
| **Accidental deletion** | Consent history uses RESTRICT FKs (hard to delete accidentally), and services **archive** rather than hard-delete. For a genuine data-loss event, restore to a scratch DB and re-import the affected rows. |

---

## Checklist (for the deployer to implement)

- [ ] Scheduled nightly `pg_dump` (Task Scheduler) → off-host, **encrypted** storage.
- [ ] `APP_SECRET` captured in a secrets vault, **separate** from DB backups.
- [ ] Retention policy applied (e.g. 30 daily + 12 monthly) with automated pruning.
- [ ] Access to backups restricted + retrievals logged (they contain PII + secrets).
- [ ] **Quarterly tested-restore drill** performed and recorded.
- [ ] RPO/RTO targets agreed and documented.
- [ ] (Optional) WAL archiving / PITR if a sub-day RPO is required.
