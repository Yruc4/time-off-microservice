# Time-Off Microservice

High-reliability Node.js microservice (NestJS + TypeScript) that manages employee time-off requests while keeping a local SQLite cache synchronized with an external HCM (Human Capital Management) system — the authoritative source of truth.

> **Language note:** The solution is written in TypeScript, a typed superset of JavaScript. The compiled output in `dist/` runs on plain Node.js without any TypeScript tooling.

---

## Quick Start

### Prerequisites

- **Node.js 18+**
- **npm 9+**

### Install & run

```bash
# 1. Install dependencies
npm install

# 2a. Development mode (auto-reload on file changes)
npm run start:dev

# 2b. Production mode (compile first, then start)
npm run build && npm start
```

The server starts on **http://localhost:3000**.

> If port 3000 is already in use, stop the conflicting process or set the `PORT` environment variable before starting.

---

## Running Tests

```bash
# Full suite — all 53 tests across 6 suites (recommended)
npm test

# With coverage report (opens HTML in coverage/lcov-report/index.html)
npm run test:cov

# Individual suites
npm run test:unit          # Unit tests — mocked dependencies, fast
npm run test:int           # Integration — real in-memory SQLite, mock HCM
npm run test:concurrency   # Concurrency — race-condition invariant checks
```

All **53 tests** pass out of the box across 6 suites:

| Suite | Tests | What it covers |
|---|---|---|
| `test/unit/time-off.service.spec.ts` | 12 | Service logic with mocked repos and HCM |
| `test/unit/global-exception-filter.spec.ts` | 10 | Error-code → HTTP status mapping |
| `test/integration/time-off.integration.spec.ts` | 13 | Full stack with real SQLite, including work anniversary scenarios |
| `test/concurrency/time-off.concurrency.spec.ts` | 4 | Concurrent requests, optimistic lock, race safety |
| `test/e2e/time-off.e2e.spec.ts` | 8 | HTTP server via supertest — all routes, validation, routing |
| `test/e2e/hcm-real-http.spec.ts` | 6 | Real TCP socket to standalone mock HCM HTTP server |

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
│   ├── hcm-proxy/         # HcmProxyService, MockHcmService, HcmHttpService
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
├── integration/           # Real SQLite, in-process mock HCM
├── concurrency/           # Parallel-request invariant tests
└── e2e/
    ├── time-off.e2e.spec.ts       # Supertest against real HTTP server
    ├── hcm-real-http.spec.ts      # Tests over real TCP to standalone HCM mock
    └── mock-hcm-server.ts         # Standalone Node.js HTTP mock HCM server
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
