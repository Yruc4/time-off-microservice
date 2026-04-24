# Technical Requirements Document — Time-Off Microservice

## 1. Problem Statement

ReadyOn is the UI for time-off requests. The HCM (Human Capital Management system) is the **Source of Truth** for employee leave balances. This split ownership creates a class of bug we call **Distributed State Drift**:

| Drift cause | How it happens |
|---|---|
| Work anniversaries | HCM automatically awards extra days; ReadyOn never learns |
| Manual HCM adjustments | HR edits a balance directly in HCM |
| Failed dual-writes | Our commit succeeds in HCM but crashes before updating local DB |
| Partial outages | HCM is unavailable; we accept requests based on stale local data |

Without explicit countermeasures, ReadyOn can approve requests for days the employee no longer has, or deny requests for days that were quietly restored.

---

## 2. The Dual-Write Problem

A **dual-write** occurs when a single logical operation must persist to two independent stores (HCM + local SQLite). There is no distributed transaction spanning both; therefore, they can diverge.

### Failure matrix

```
Step 1: Write to HCM     ✓ success
Step 2: Write to local   ✗ crash / lock / timeout
```

This leaves an **orphaned request**: the HCM balance is deducted, but our local DB still shows the original balance and the request record is stuck in `PENDING`.

### Mitigation strategy (this implementation)

```
1. Write PENDING record FIRST (idempotency anchor).
2. Call HCM.
3. If HCM approves → atomic transaction: deduct local balance + mark APPROVED.
4. If transaction fails → request stays PENDING.
   ReconciliationService detects PENDING records older than 5 minutes (orphan TTL).
   Next reconcile-from-HCM pull restores the true balance and surfaces orphan IDs.
```

The PENDING record is the **audit trail**. It proves the request existed even when the final state is uncertain.

---

## 3. Idempotency

### Why it matters

Network retries, client timeouts, and message-queue redeliveries all cause duplicate submissions. Without idempotency, a single vacation request could deduct the balance multiple times.

### Implementation

Every request carries a client-generated `request_id` (UUID recommended). It maps to a `UNIQUE INDEX` on `time_off_requests.request_id`.

```
Client → POST /api/time-off/request { request_id: "uuid-v4", ... }

Service logic:
  SELECT * FROM time_off_requests WHERE request_id = ?
  IF found  → return existing row immediately (no re-processing)
  IF not found → proceed with full flow
```

The `UNIQUE` constraint is a safety net: even if two in-flight concurrent calls both pass the "not found" check simultaneously, the second `INSERT` will raise `SQLITE_CONSTRAINT_UNIQUE` → caught by `GlobalExceptionFilter` → `HTTP 409 DUPLICATE_REQUEST_ID`.

### HCM-side idempotency

`MockHcmService` also tracks processed `request_id` values in a `Set`. A replayed ID returns the same answer without re-deducting. This mirrors what a production HCM must guarantee.

---

## 4. Locking Mechanism

### Why we need it

Without locking, two concurrent requests for the same employee can both pass the local balance check (both read `balance = 5`), both call HCM (which serializes them), but then both attempt to write their computed result (`5 - 3 = 2`) to the same local row, producing `balance = 2` instead of the correct `-1` (which HCM would deny) or `2` after the second is correctly rejected.

### Chosen mechanism: Optimistic Locking (TypeORM `@VersionColumn`)

```typescript
@VersionColumn()
version: number;
```

TypeORM auto-generates:
```sql
UPDATE employee_balances
SET balance = ?, version = version + 1
WHERE id = ? AND version = ?   -- ← the lock
```

If two writers both loaded `version = 1`, one will commit (`version` becomes 2) and the other's `WHERE version = 1` matches **zero rows** → TypeORM raises `OptimisticLockVersionMismatchError` → service returns `HTTP 409 OPTIMISTIC_LOCK_CONFLICT` with a "please retry" message.

### Why not pessimistic locking?

| | Optimistic | Pessimistic |
|---|---|---|
| SQLite support | ✓ native via version column | Partial — `BEGIN EXCLUSIVE` blocks all readers |
| Throughput | High (no lock held during HCM call) | Low (lock held for the entire HCM round-trip, often 100–500 ms) |
| Deadlock risk | None | Present under high concurrency |
| Failure mode | Fast retry on conflict | Queue starvation |

Optimistic locking is correct here because conflicts are **rare** (each employee's request volume is low). The version increment cost is negligible.

---

## 5. The Sync Strategy ("Golden Logic")

```
Request Flow
───────────
POST /api/time-off/request
  │
  ├─ [1] Check existing request_id → idempotent return if found
  │
  ├─ [2] Load local EmployeeBalance
  │       └─ balance < days_requested → HTTP 400 (fast-fail, no HCM call)
  │
  ├─ [3] INSERT TimeOffRequest { status: PENDING }
  │       (idempotency anchor — survives crashes)
  │
  ├─ [4] POST HCM /validate-and-deduct
  │       ├─ network error → mark FAILED, HTTP 503
  │       └─ HCM denies   → mark FAILED, HTTP 400
  │
  └─ [5] BEGIN TRANSACTION
          ├─ UPDATE EmployeeBalance (version check = optimistic lock)
          ├─ UPDATE TimeOffRequest  status → APPROVED
          └─ COMMIT
              └─ if fails → request stays PENDING (orphan)

Batch Reconciliation
────────────────────
POST /api/time-off/reconcile                (HCM pushes corpus)
POST /api/time-off/reconcile/pull-from-hcm  (we pull from HCM)
  │
  └─ For each { employee_id, location_id, balance } in HCM payload:
      ├─ UPSERT EmployeeBalance  (overwrite, fixes drift)
      └─ scan PENDING records older than 5 min → log orphan IDs
```

---

## 6. Entity Design

### `employee_balances`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `employee_id` | TEXT | |
| `location_id` | TEXT | Balances are location-scoped |
| `balance` | REAL | Days remaining |
| `version` | INTEGER | Optimistic lock counter |
| `last_synced_at` | DATETIME | Last reconciliation timestamp |
| UNIQUE | `(employee_id, location_id)` | One record per employee-location pair |

### `time_off_requests`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `request_id` | TEXT UNIQUE | Client idempotency key |
| `employee_id` | TEXT | |
| `location_id` | TEXT | |
| `days_requested` | REAL | |
| `status` | TEXT | `PENDING` / `APPROVED` / `FAILED` |
| `hcm_response` | TEXT | JSON blob of HCM response |
| `failure_reason` | TEXT | Human-readable failure cause |

---

## 7. API Surface

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/time-off/request` | Submit a time-off request (idempotent) |
| `GET` | `/api/time-off/balance/:emp/:loc` | Read local cached balance |
| `GET` | `/api/time-off/request/:request_id` | Retrieve request by idempotency key |
| `POST` | `/api/time-off/reconcile` | Push reconciliation corpus |
| `POST` | `/api/time-off/reconcile/pull-from-hcm` | Pull reconciliation corpus from HCM |

---

## 8. Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `HTTP_EXCEPTION` | Validation or business rule failure |
| 409 | `DUPLICATE_REQUEST_ID` | Same `request_id` inserted twice concurrently |
| 409 | `OPTIMISTIC_LOCK_CONFLICT` | Concurrent write detected; client should retry |
| 503 | `HTTP_EXCEPTION` | HCM unavailable or local commit failed post-HCM |

---

## 9. Production Hardening Checklist (out of scope for this implementation)

- [ ] Replace `MockHcmService` with `HttpService` call to real HCM endpoint
- [ ] Add circuit-breaker (e.g. `nestjs-resilience` / `opossum`) around HCM calls
- [ ] Scheduled job (every N minutes) calling `reconcile/pull-from-hcm`
- [ ] Auto-resolve orphaned PENDING requests via the reconcile scan
- [ ] Move from SQLite to PostgreSQL for multi-replica deployments (advisory locks)
- [ ] Distributed tracing (OpenTelemetry) on HCM calls
- [ ] `request_id` expiry — reject stale idempotency keys after 24 h
