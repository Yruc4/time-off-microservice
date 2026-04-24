import * as http from 'http';

interface BalanceEntry {
  employee_id: string;
  location_id: string;
  balance: number;
}

/**
 * Standalone Node.js HTTP server that simulates a real HCM system.
 *
 * Spun up in tests to satisfy the spec requirement for "real mock servers"
 * with basic logic to simulate balance changes. Runs on a random OS-assigned
 * port so tests never conflict.
 *
 * Endpoints:
 *   POST /deduct          — validate and deduct (main HCM real-time API)
 *   GET  /balances        — return full corpus (HCM batch endpoint)
 *
 * Test-helper endpoints (not part of the HCM contract, used for setup):
 *   POST /seed            — seed a balance entry
 *   POST /reset           — wipe all state
 *   POST /fail-next       — force the next /deduct call to return HTTP 503
 */
export class MockHcmHttpServer {
  private readonly store = new Map<string, BalanceEntry>();
  private readonly processed = new Set<string>();
  private _failNext = false;
  private _server: http.Server;
  private _port: number;

  constructor() {
    this._server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        this._json(res, 500, { error: String(err) });
      });
    });
  }

  // ── Public lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this._server.listen(0, '127.0.0.1', () => {
        this._port = (this._server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  // ── Request router ──────────────────────────────────────────────────────────

  private async _handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const { method, url } = req;

    if (method === 'POST' && url === '/deduct') {
      return this._handleDeduct(req, res);
    }
    if (method === 'GET' && url === '/balances') {
      return this._handleBulkBalances(res);
    }
    if (method === 'POST' && url === '/seed') {
      return this._handleSeed(req, res);
    }
    if (method === 'POST' && url === '/reset') {
      return this._handleReset(res);
    }
    if (method === 'POST' && url === '/fail-next') {
      return this._handleFailNext(res);
    }

    this._json(res, 404, { error: `Unknown route: ${method} ${url}` });
  }

  // ── HCM endpoints ───────────────────────────────────────────────────────────

  private async _handleDeduct(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (this._failNext) {
      this._failNext = false;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'HCM service unavailable (simulated)' }));
      return;
    }

    const body = await this._readBody(req);
    const { request_id, employee_id, location_id, days_requested } = body;
    const k = this._key(employee_id, location_id);

    // HCM-side idempotency
    if (this.processed.has(request_id)) {
      const entry = this.store.get(k);
      return this._json(res, 200, {
        success: true,
        remaining_balance: entry?.balance ?? 0,
        message: 'Already processed (idempotent replay)',
        hcm_transaction_id: `hcm-idem-${request_id}`,
      });
    }

    const entry = this.store.get(k);
    if (!entry) {
      return this._json(res, 200, {
        success: false,
        remaining_balance: 0,
        message: `Employee ${employee_id} at location ${location_id} not found in HCM`,
      });
    }

    if (entry.balance < days_requested) {
      return this._json(res, 200, {
        success: false,
        remaining_balance: entry.balance,
        message: `Insufficient Funds: requested ${days_requested} days, only ${entry.balance} available`,
      });
    }

    entry.balance -= days_requested;
    this.processed.add(request_id);

    this._json(res, 200, {
      success: true,
      remaining_balance: entry.balance,
      message: 'Balance deducted successfully',
      hcm_transaction_id: `hcm-txn-${Date.now()}`,
    });
  }

  private _handleBulkBalances(res: http.ServerResponse): void {
    const balances = Array.from(this.store.values()).map(
      ({ employee_id, location_id, balance }) => ({
        employee_id,
        location_id,
        balance,
      }),
    );

    this._json(res, 200, {
      balances,
      snapshot_at: new Date().toISOString(),
    });
  }

  // ── Test-helper endpoints ───────────────────────────────────────────────────

  private async _handleSeed(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const { employee_id, location_id, balance } = await this._readBody(req);
    this.store.set(this._key(employee_id, location_id), {
      employee_id,
      location_id,
      balance,
    });
    this._json(res, 200, { ok: true });
  }

  private _handleReset(res: http.ServerResponse): void {
    this.store.clear();
    this.processed.clear();
    this._failNext = false;
    this._json(res, 200, { ok: true });
  }

  private _handleFailNext(res: http.ServerResponse): void {
    this._failNext = true;
    this._json(res, 200, { ok: true });
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  private _key(employee_id: string, location_id: string): string {
    return `${employee_id}::${location_id}`;
  }

  private async _readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
    });
  }

  private _json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
