import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER } from '@nestjs/core';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { EmployeeBalance } from '../../src/domain/entities/employee-balance.entity';
import {
  TimeOffRequest,
  TimeOffRequestStatus,
} from '../../src/domain/entities/time-off-request.entity';
import { TimeOffModule } from '../../src/modules/time-off/time-off.module';
import { HcmProxyModule } from '../../src/modules/hcm-proxy/hcm-proxy.module';
import { HcmProxyService } from '../../src/modules/hcm-proxy/hcm-proxy.service';
import { HcmHttpService } from '../../src/modules/hcm-proxy/hcm-http.service';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { MockHcmHttpServer } from './mock-hcm-server';

/**
 * Real-HTTP E2E Suite
 *
 * This test suite wires the NestJS application to a real, standalone HTTP mock
 * server instead of the in-process MockHcmService. Every HCM interaction crosses
 * an actual TCP socket, proving the HTTP transport layer works end-to-end and
 * satisfying the spec requirement for "real mock servers with basic logic to
 * simulate balance changes".
 *
 * Architecture:
 *   supertest → NestJS app → HcmHttpService → MockHcmHttpServer (real HTTP)
 */

const EMP = 'emp-http-01';
const LOC = 'loc-http-boston';

/** Convenience wrapper: call a test-helper endpoint on the mock HCM server. */
async function hcmControl(
  baseUrl: string,
  path: string,
  body?: object,
): Promise<void> {
  await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('TimeOff — Real HTTP mock server (HcmHttpService + MockHcmHttpServer)', () => {
  let app: INestApplication;
  let mockHcm: MockHcmHttpServer;
  let dataSource: DataSource;

  beforeAll(async () => {
    // ── 1. Start the standalone mock HCM HTTP server ────────────────────────
    mockHcm = new MockHcmHttpServer();
    await mockHcm.start();

    // ── 2. Build NestJS app, overriding HcmProxyService to use HTTP ─────────
    const hcmHttpService = new HcmHttpService(mockHcm.baseUrl);

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqljs',
          useLocalForage: false,
          entities: [EmployeeBalance, TimeOffRequest],
          synchronize: true,
          logging: false,
        }),
        HcmProxyModule,
        TimeOffModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: GlobalExceptionFilter }],
    })
      // Swap the HcmProxyService delegate so all HCM calls go over real HTTP
      .overrideProvider(HcmProxyService)
      .useValue(hcmHttpService)
      .compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();

    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
    await mockHcm.stop();
  });

  beforeEach(async () => {
    await dataSource.getRepository(TimeOffRequest).clear();
    await dataSource.getRepository(EmployeeBalance).clear();
    await hcmControl(mockHcm.baseUrl, '/reset');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Happy path over real HTTP
  // ────────────────────────────────────────────────────────────────────────────

  it('happy path: seeds HCM via HTTP → reconcile → request approved → balance decremented', async () => {
    await hcmControl(mockHcm.baseUrl, '/seed', {
      employee_id: EMP,
      location_id: LOC,
      balance: 10,
    });

    // Pull balance from mock HCM server over real HTTP
    await request(app.getHttpServer())
      .post('/api/time-off/reconcile/pull-from-hcm')
      .expect(200)
      .expect((res) => {
        expect(res.body.data.created).toBe(1);
      });

    // Submit time-off request — goes through HTTP to mock HCM
    await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send({
        request_id: 'http-req-001',
        employee_id: EMP,
        location_id: LOC,
        days_requested: 3,
      })
      .expect(201)
      .expect((res) => {
        expect(res.body.data.status).toBe(TimeOffRequestStatus.APPROVED);
      });

    // Local balance should reflect the deduction
    await request(app.getHttpServer())
      .get(`/api/time-off/balance/${EMP}/${LOC}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.data.balance).toBe(7);
      });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // HCM denies insufficient funds over real HTTP
  // ────────────────────────────────────────────────────────────────────────────

  it('HCM returns insufficient funds over HTTP → request rejected, local balance unchanged', async () => {
    await hcmControl(mockHcm.baseUrl, '/seed', {
      employee_id: EMP,
      location_id: LOC,
      balance: 10,
    });
    await request(app.getHttpServer())
      .post('/api/time-off/reconcile/pull-from-hcm')
      .expect(200);

    // Simulate HCM balance drifting to 1 externally (before the request)
    await hcmControl(mockHcm.baseUrl, '/seed', {
      employee_id: EMP,
      location_id: LOC,
      balance: 1,
    });

    // Request for 5 passes local cache (still shows 10) but HCM denies it
    await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send({
        request_id: 'http-deny-001',
        employee_id: EMP,
        location_id: LOC,
        days_requested: 5,
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.message).toMatch(/Insufficient Funds/);
      });

    // Local balance was NOT touched
    await request(app.getHttpServer())
      .get(`/api/time-off/balance/${EMP}/${LOC}`)
      .expect((res) => {
        expect(res.body.data.balance).toBe(10);
      });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Work anniversary — HCM balance increases, reconcile syncs it
  // ────────────────────────────────────────────────────────────────────────────

  it('work anniversary: HCM balance boosted externally via HTTP seed → reconcile → employee can book more', async () => {
    // Start: employee has 2 days
    await hcmControl(mockHcm.baseUrl, '/seed', { employee_id: EMP, location_id: LOC, balance: 2 });
    await request(app.getHttpServer()).post('/api/time-off/reconcile/pull-from-hcm').expect(200);

    // Deplete balance
    await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send({ request_id: 'http-anni-pre', employee_id: EMP, location_id: LOC, days_requested: 2 })
      .expect(201);

    expect(
      (await request(app.getHttpServer()).get(`/api/time-off/balance/${EMP}/${LOC}`)).body.data.balance,
    ).toBe(0);

    // Work anniversary fires in HCM — balance boosted to 15 (external change via HTTP)
    await hcmControl(mockHcm.baseUrl, '/seed', { employee_id: EMP, location_id: LOC, balance: 15 });

    // Before reconcile: still blocked
    await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send({ request_id: 'http-anni-block', employee_id: EMP, location_id: LOC, days_requested: 5 })
      .expect(400);

    // Reconcile pulls from HCM server over HTTP — local balance updated
    await request(app.getHttpServer())
      .post('/api/time-off/reconcile/pull-from-hcm')
      .expect(200)
      .expect((res) => {
        expect(res.body.data.updated).toBe(1);
      });

    expect(
      (await request(app.getHttpServer()).get(`/api/time-off/balance/${EMP}/${LOC}`)).body.data.balance,
    ).toBe(15);

    // Employee can now book days after the anniversary bonus
    await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send({ request_id: 'http-anni-post', employee_id: EMP, location_id: LOC, days_requested: 5 })
      .expect(201)
      .expect((res) => {
        expect(res.body.data.status).toBe(TimeOffRequestStatus.APPROVED);
      });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // HCM HTTP 503 — service unavailable
  // ────────────────────────────────────────────────────────────────────────────

  it('HCM returns 503 over HTTP → request saved as FAILED, 503 returned to caller', async () => {
    await hcmControl(mockHcm.baseUrl, '/seed', { employee_id: EMP, location_id: LOC, balance: 10 });
    await request(app.getHttpServer()).post('/api/time-off/reconcile/pull-from-hcm').expect(200);

    // Instruct mock server to fail the next /deduct call
    await hcmControl(mockHcm.baseUrl, '/fail-next');

    await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send({ request_id: 'http-503-001', employee_id: EMP, location_id: LOC, days_requested: 2 })
      .expect(503);

    // Request persisted as FAILED for audit trail
    await request(app.getHttpServer())
      .get('/api/time-off/request/http-503-001')
      .expect(200)
      .expect((res) => {
        expect(res.body.data.status).toBe(TimeOffRequestStatus.FAILED);
        expect(res.body.data.failure_reason).toMatch(/HCM unreachable/);
      });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Idempotency over real HTTP
  // ────────────────────────────────────────────────────────────────────────────

  it('idempotent duplicate request: second call returns same result without double-deducting', async () => {
    await hcmControl(mockHcm.baseUrl, '/seed', { employee_id: EMP, location_id: LOC, balance: 10 });
    await request(app.getHttpServer()).post('/api/time-off/reconcile/pull-from-hcm').expect(200);

    const payload = { request_id: 'http-idem-001', employee_id: EMP, location_id: LOC, days_requested: 3 };

    const first = await request(app.getHttpServer()).post('/api/time-off/request').send(payload).expect(201);
    const second = await request(app.getHttpServer()).post('/api/time-off/request').send(payload).expect(201);

    expect(first.body.data.id).toBe(second.body.data.id);

    // Balance deducted only once
    await request(app.getHttpServer())
      .get(`/api/time-off/balance/${EMP}/${LOC}`)
      .expect((res) => {
        expect(res.body.data.balance).toBe(7);
      });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Bulk balances — HCM batch endpoint over HTTP
  // ────────────────────────────────────────────────────────────────────────────

  it('bulk reconcile: mock HCM serves multiple employees via HTTP batch endpoint', async () => {
    const employees = [
      { employee_id: 'emp-bulk-01', location_id: 'loc-nyc', balance: 8 },
      { employee_id: 'emp-bulk-02', location_id: 'loc-sf', balance: 12 },
      { employee_id: 'emp-bulk-03', location_id: 'loc-nyc', balance: 5 },
    ];

    for (const e of employees) {
      await hcmControl(mockHcm.baseUrl, '/seed', e);
    }

    await request(app.getHttpServer())
      .post('/api/time-off/reconcile/pull-from-hcm')
      .expect(200)
      .expect((res) => {
        expect(res.body.data.processed).toBe(3);
        expect(res.body.data.created).toBe(3);
      });

    // Spot-check one employee's balance
    await request(app.getHttpServer())
      .get('/api/time-off/balance/emp-bulk-02/loc-sf')
      .expect(200)
      .expect((res) => {
        expect(res.body.data.balance).toBe(12);
      });
  });
});
