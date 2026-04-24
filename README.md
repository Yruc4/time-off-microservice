# Time-Off Microservice

High-reliability NestJS microservice that manages employee time-off requests while keeping a local SQLite cache synchronized with an external HCM (Human Capital Management) system — the authoritative source of truth.

## Architecture

```
src/
├── domain/
│   ├── entities/          # TypeORM entities (EmployeeBalance, TimeOffRequest)
│   └── interfaces/        # HCM proxy contract
├── modules/
│   ├── hcm-proxy/         # MockHcmService + HcmProxyService
│   └── time-off/          # TimeOffService, ReconciliationService, Controller
├── common/
│   ├── dto/               # Request/Response DTOs with class-validator
│   └── filters/           # GlobalExceptionFilter
├── app.module.ts
└── main.ts
docs/
└── TRD.md                 # Technical design — dual-write, idempotency, locking
test/
├── unit/                  # Mocked dependencies
├── integration/           # Real in-memory SQLite, mock HCM
└── concurrency/           # Concurrent-request invariant tests
```

## Prerequisites

- Node.js 18+
- npm 9+

## Installation

```bash
cd /path/to/NewProject
npm install
```

## Running the server

```bash
# Development (watch mode)
npm run start:dev

# Production
npm run build && npm start
```

The server starts on `http://localhost:3000`.

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
`request_id` is your idempotency key — submitting the same value twice returns the original result without re-processing.

### Read local balance
```
GET /api/time-off/balance/:employee_id/:location_id
```

### Look up a request
```
GET /api/time-off/request/:request_id
```

### Push reconciliation corpus (HCM → ReadyOn)
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

### Pull reconciliation from HCM
```
POST /api/time-off/reconcile/pull-from-hcm
```

## Running Tests

```bash
# All tests (recommended)
npm test

# Unit tests only (mocked deps, fast)
npm run test:unit

# Integration tests (real SQLite, mock HCM)
npm run test:int

# Concurrency tests (invariant checks under parallel requests)
npm run test:concurrency

# Coverage report
npm run test:cov
```

## Key Design Decisions

See [docs/TRD.md](docs/TRD.md) for the full technical design. Summary:

| Concern | Solution |
|---|---|
| Distributed state drift | Batch reconciliation overwrites local balances with HCM corpus |
| Dual-write failure | PENDING record persists before HCM call; orphan detection on reconcile |
| Idempotency | Client-supplied `request_id` with UNIQUE index; returns original result on replay |
| Concurrency | Optimistic locking via `@VersionColumn()`; conflict → HTTP 409 + retry |
| HCM unavailable | Request marked FAILED immediately; local balance untouched |
| Fast-fail | Local balance check before any HCM network call |

## Request States

```
PENDING  → Request written, HCM call in flight (or DB commit pending)
APPROVED → HCM confirmed + local balance updated atomically
FAILED   → HCM denied, HCM unreachable, or validation failure
```
