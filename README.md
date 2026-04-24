# Time-Off Microservice

High-reliability Node.js microservice (NestJS + TypeScript) that manages employee time-off requests while keeping a local SQLite cache synchronized with an external HCM (Human Capital Management) system — the authoritative source of truth.

> **Language note:** The solution is written in TypeScript, which is a typed superset of JavaScript that compiles 1-to-1 to plain JavaScript. The compiled output lives in `dist/` and is runnable with Node.js without any TypeScript tooling.

---

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+

### Install & run

```bash
# 1. Install dependencies
npm install

# 2a. Development mode (auto-reload on file changes)
npm run start:dev

# 2b. Production mode (compile first, then start)
npm run build && npm start
```

The server starts on `http://localhost:3000`.

---

## Running Tests

```bash
# All tests (unit + integration + concurrency) — recommended
npm test

# Individually
npm run test:unit          # Mocked dependencies, fast
npm run test:int           # Real in-memory SQLite, mock HCM
npm run test:concurrency   # Race-condition invariant checks
npm run test:cov           # Coverage report
```

All 22 tests pass out of the box.

---

## API Reference

### Submit a time-off request
```
POST /api/time-off/request
Content-Type: application/json

{
  "request_id": "uuid-v4-client-generated",
  "employee_id": "emp-001",
  "location_id": "loc-nyc",
  "days_requested": 3
}
```
`request_id` is the idempotency key — submitting the same value twice returns the original result without re-processing.

**Responses**

| Status | Meaning |
|--------|---------|
| 200 | Request approved (or returning a previously seen `request_id`) |
| 400 | HCM denied (insufficient balance, invalid request) |
| 409 | Optimistic-lock conflict — safe to retry |
| 503 | HCM unreachable — safe to retry |

### Read local cached balance
```
GET /api/time-off/balance/:employee_id/:location_id
```

### Look up a request by idempotency key
```
GET /api/time-off/request/:request_id
```

### Push reconciliation corpus (HCM → local)
```
POST /api/time-off/reconcile
Content-Type: application/json

{
  "balances": [
    { "employee_id": "emp-001", "location_id": "loc-nyc", "balance": 12 },
    { "employee_id": "emp-002", "location_id": "loc-nyc", "balance": 5 }
  ]
}
```

### Pull full balance corpus from HCM
```
POST /api/time-off/reconcile/pull-from-hcm
```

---

## Architecture

```
src/
├── domain/
│   ├── entities/          # TypeORM entities (EmployeeBalance, TimeOffRequest)
│   └── interfaces/        # HCM proxy contract
├── modules/
│   ├── hcm-proxy/         # HcmProxyService + MockHcmService
│   └── time-off/          # TimeOffService, ReconciliationService, Controller
├── common/
│   ├── dto/               # Request validation DTOs (class-validator)
│   └── filters/           # GlobalExceptionFilter — maps errors to HTTP codes
├── app.module.ts
└── main.ts
docs/
└── TRD.md                 # Full technical design document
test/
├── unit/                  # Mocked dependencies
├── integration/           # Real SQLite, mock HCM
└── concurrency/           # Parallel-request invariant tests
```

---

## Key Design Decisions

See [docs/TRD.md](docs/TRD.md) for the full technical rationale.

| Concern | Solution |
|---------|---------|
| Distributed state drift | Batch reconciliation overwrites local balances with HCM corpus |
| Dual-write failure | PENDING record persists before HCM call; orphan detection on reconcile |
| Idempotency | Client-supplied `request_id` with UNIQUE DB index; replays return original result |
| Concurrency | Optimistic locking via `@VersionColumn()`; conflict → HTTP 409, safe to retry |
| HCM unavailable | Request marked FAILED immediately; local balance untouched |
| Fast-fail | Local balance checked before any HCM network call |

---

## Security Considerations

- **Input validation** — All request bodies are validated with `class-validator` decorators before reaching business logic. Invalid payloads are rejected at the controller boundary with HTTP 400.
- **No raw SQL** — All database access goes through TypeORM query builder / repository API, eliminating SQL injection risk.
- **Idempotency key collision** — Duplicate `request_id` values are detected via a database UNIQUE constraint, not application-level checks, making collision handling atomic and race-safe.
- **Optimistic locking** — Concurrent writes to the same balance row are detected by a version column; losing writers receive HTTP 409 and must retry, preventing silent data corruption.
- **Orphan detection** — PENDING requests older than 5 minutes (HCM approved but local commit failed) are flagged on every reconciliation run for manual investigation, preventing approved-but-unrecorded deductions.
- **Structured error responses** — The global exception filter maps all internal exceptions to typed HTTP responses (`DUPLICATE_REQUEST_ID`, `OPTIMISTIC_LOCK_CONFLICT`, `DATABASE_ERROR`) without leaking stack traces or internal state.

---

## Request State Machine

```
PENDING  → Request written to DB; HCM call in flight (or DB commit pending)
APPROVED → HCM confirmed deduction + local balance updated atomically
FAILED   → HCM denied, HCM unreachable, or validation failure
```
