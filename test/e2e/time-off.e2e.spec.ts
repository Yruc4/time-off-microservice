import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER } from '@nestjs/core';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { EmployeeBalance } from '../../src/domain/entities/employee-balance.entity';
import { TimeOffRequest } from '../../src/domain/entities/time-off-request.entity';
import { TimeOffModule } from '../../src/modules/time-off/time-off.module';
import { HcmProxyModule } from '../../src/modules/hcm-proxy/hcm-proxy.module';
import { MockHcmService } from '../../src/modules/hcm-proxy/mock-hcm.service';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';

const EMP = 'emp-e2e-01';
const LOC = 'loc-e2e-boston';

describe('TimeOff — E2E (HTTP server + supertest)', () => {
  let app: INestApplication;
  let hcm: MockHcmService;
  let dataSource: DataSource;

  beforeAll(async () => {
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
    }).compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();

    hcm = module.get(MockHcmService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.getRepository(TimeOffRequest).clear();
    await dataSource.getRepository(EmployeeBalance).clear();
    hcm.reset();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Balance endpoint
  // ────────────────────────────────────────────────────────────────────────────

  it('GET /api/time-off/balance/:emp/:loc — 400 when no balance record exists', async () => {
    await request(app.getHttpServer())
      .get(`/api/time-off/balance/${EMP}/${LOC}`)
      .expect(400)
      .expect((res) => {
        expect(res.body.code).toBe('HTTP_EXCEPTION');
      });
  });

  it('GET /api/time-off/balance/:emp/:loc — 200 with balance after reconcile', async () => {
    hcm.seedBalance(EMP, LOC, 8);
    await request(app.getHttpServer())
      .post('/api/time-off/reconcile/pull-from-hcm')
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/time-off/balance/${EMP}/${LOC}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.data.balance).toBe(8);
        expect(res.body.data.employee_id).toBe(EMP);
        expect(res.body.data.location_id).toBe(LOC);
      });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Request time-off endpoint
  // ────────────────────────────────────────────────────────────────────────────

  it('POST /api/time-off/request — 201 APPROVED on happy path', async () => {
    hcm.seedBalance(EMP, LOC, 10);
    await request(app.getHttpServer())
      .post('/api/time-off/reconcile/pull-from-hcm')
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send({
        request_id: 'e2e-req-001',
        employee_id: EMP,
        location_id: LOC,
        days_requested: 3,
      })
      .expect(201)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBe('APPROVED');
        expect(res.body.data.request_id).toBe('e2e-req-001');
      });
  });

  it('POST /api/time-off/request — 400 when local balance insufficient', async () => {
    hcm.seedBalance(EMP, LOC, 2);
    await request(app.getHttpServer())
      .post('/api/time-off/reconcile/pull-from-hcm')
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send({
        request_id: 'e2e-req-002',
        employee_id: EMP,
        location_id: LOC,
        days_requested: 5,
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.code).toBe('HTTP_EXCEPTION');
        expect(res.body.message).toMatch(/insufficient/i);
      });
  });

  it('POST /api/time-off/request — idempotent: second identical request returns same result', async () => {
    hcm.seedBalance(EMP, LOC, 10);
    await request(app.getHttpServer())
      .post('/api/time-off/reconcile/pull-from-hcm')
      .expect(200);

    const payload = {
      request_id: 'e2e-idem-001',
      employee_id: EMP,
      location_id: LOC,
      days_requested: 2,
    };

    const first = await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send(payload)
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send(payload)
      .expect(201);

    expect(first.body.data.id).toBe(second.body.data.id);
    expect(second.body.data.status).toBe('APPROVED');
  });

  it('POST /api/time-off/request — 422 when validation fails (missing field)', async () => {
    await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send({ employee_id: EMP, location_id: LOC, days_requested: 3 }) // missing request_id
      .expect(400); // ValidationPipe returns 400
  });

  it('POST /api/time-off/request — 400 when no balance record exists', async () => {
    await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send({
        request_id: 'e2e-req-nobal',
        employee_id: EMP,
        location_id: LOC,
        days_requested: 1,
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.message).toMatch(/reconciliation/i);
      });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Get request by ID
  // ────────────────────────────────────────────────────────────────────────────

  it('GET /api/time-off/request/:id — 200 after submission', async () => {
    hcm.seedBalance(EMP, LOC, 10);
    await request(app.getHttpServer())
      .post('/api/time-off/reconcile/pull-from-hcm')
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/time-off/request')
      .send({
        request_id: 'e2e-get-001',
        employee_id: EMP,
        location_id: LOC,
        days_requested: 1,
      })
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/time-off/request/e2e-get-001')
      .expect(200)
      .expect((res) => {
        expect(res.body.data.request_id).toBe('e2e-get-001');
        expect(res.body.data.status).toBe('APPROVED');
      });
  });

  it('GET /api/time-off/request/:id — 400 when request not found', async () => {
    await request(app.getHttpServer())
      .get('/api/time-off/request/nonexistent-id')
      .expect(400);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Reconcile endpoints
  // ────────────────────────────────────────────────────────────────────────────

  it('POST /api/time-off/reconcile — 200 with pushed payload', async () => {
    await request(app.getHttpServer())
      .post('/api/time-off/reconcile')
      .send({
        balances: [
          { employee_id: EMP, location_id: LOC, balance: 15 },
        ],
      })
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.data.processed).toBe(1);
      });
  });

  it('POST /api/time-off/reconcile — 400 when payload is invalid', async () => {
    await request(app.getHttpServer())
      .post('/api/time-off/reconcile')
      .send({ balances: [{ employee_id: EMP }] }) // missing location_id and balance
      .expect(400);
  });

  it('POST /api/time-off/reconcile/pull-from-hcm — 200 and creates balance records', async () => {
    hcm.seedBalance(EMP, LOC, 12);
    hcm.seedBalance('emp-e2e-02', 'loc-e2e-sf', 5);

    await request(app.getHttpServer())
      .post('/api/time-off/reconcile/pull-from-hcm')
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.data.processed).toBe(2);
        expect(res.body.data.created).toBe(2);
      });
  });
});
