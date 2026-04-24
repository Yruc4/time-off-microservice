import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EmployeeBalance } from '../../src/domain/entities/employee-balance.entity';
import {
  TimeOffRequest,
  TimeOffRequestStatus,
} from '../../src/domain/entities/time-off-request.entity';
import { TimeOffModule } from '../../src/modules/time-off/time-off.module';
import { HcmProxyModule } from '../../src/modules/hcm-proxy/hcm-proxy.module';
import { MockHcmService } from '../../src/modules/hcm-proxy/mock-hcm.service';
import { TimeOffService } from '../../src/modules/time-off/time-off.service';
import { ReconciliationService } from '../../src/modules/time-off/reconciliation.service';
import { APP_FILTER } from '@nestjs/core';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';

const EMP = 'emp-int-01';
const LOC = 'loc-boston';

async function buildModule(): Promise<TestingModule> {
  return Test.createTestingModule({
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
}

describe('TimeOffService — integration (real SQLite, mock HCM)', () => {
  let module: TestingModule;
  let hcm: MockHcmService;
  let timeOffService: TimeOffService;
  let reconciliationService: ReconciliationService;
  let dataSource: DataSource;

  beforeAll(async () => {
    module = await buildModule();
    hcm = module.get(MockHcmService);
    timeOffService = module.get(TimeOffService);
    reconciliationService = module.get(ReconciliationService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await dataSource.getRepository(TimeOffRequest).clear();
    await dataSource.getRepository(EmployeeBalance).clear();
    hcm.reset();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // End-to-end happy path
  // ────────────────────────────────────────────────────────────────────────────

  it('full happy path: seeds balance → approves request → local balance decremented', async () => {
    hcm.seedBalance(EMP, LOC, 10);

    // Seed local balance via reconcile
    await reconciliationService.reconcileFromHcm();

    const result = await timeOffService.requestTimeOff({
      request_id: 'int-happy-01',
      employee_id: EMP,
      location_id: LOC,
      days_requested: 4,
    });

    expect(result.status).toBe(TimeOffRequestStatus.APPROVED);
    expect(JSON.parse(result.hcm_response).remaining_balance).toBe(6);

    const balance = await timeOffService.getBalance(EMP, LOC);
    expect(balance.balance).toBe(6);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // HCM insufficient funds
  // ────────────────────────────────────────────────────────────────────────────

  it('HCM denies request → local balance unchanged (drift scenario)', async () => {
    // Seed local cache with 10 days via an initial reconcile
    hcm.seedBalance(EMP, LOC, 10);
    await reconciliationService.reconcileFromHcm(); // local = 10

    // Simulate HCM drift: balance dropped to 3 elsewhere (anniversary deduction, manual edit)
    // Local still thinks 10. Request for 5 passes local fast-fail but HCM denies it.
    hcm.reset();
    hcm.seedBalance(EMP, LOC, 3);

    await expect(
      timeOffService.requestTimeOff({
        request_id: 'int-deny-01',
        employee_id: EMP,
        location_id: LOC,
        days_requested: 5,
      }),
    ).rejects.toThrow('Insufficient Funds');

    const balance = await timeOffService.getBalance(EMP, LOC);
    expect(balance.balance).toBe(10); // local untouched — HCM is the guard
  });

  // ────────────────────────────────────────────────────────────────────────────
  // HCM network failure
  // ────────────────────────────────────────────────────────────────────────────

  it('HCM network failure → request saved as FAILED, local balance unchanged', async () => {
    hcm.seedBalance(EMP, LOC, 10);
    await reconciliationService.reconcileFromHcm();

    hcm.failNextCall();

    await expect(
      timeOffService.requestTimeOff({
        request_id: 'int-hcm-fail-01',
        employee_id: EMP,
        location_id: LOC,
        days_requested: 3,
      }),
    ).rejects.toThrow('HCM system is currently unavailable');

    const req = await timeOffService.getRequest('int-hcm-fail-01');
    expect(req.status).toBe(TimeOffRequestStatus.FAILED);
    expect(req.failure_reason).toMatch(/HCM unreachable/);

    const balance = await timeOffService.getBalance(EMP, LOC);
    expect(balance.balance).toBe(10); // local not touched
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Idempotency — duplicate submission
  // ────────────────────────────────────────────────────────────────────────────

  it('duplicate request_id returns same result without re-calling HCM', async () => {
    hcm.seedBalance(EMP, LOC, 10);
    await reconciliationService.reconcileFromHcm();

    const first = await timeOffService.requestTimeOff({
      request_id: 'int-idem-01',
      employee_id: EMP,
      location_id: LOC,
      days_requested: 2,
    });
    expect(first.status).toBe(TimeOffRequestStatus.APPROVED);

    // Submit again with the same request_id
    const second = await timeOffService.requestTimeOff({
      request_id: 'int-idem-01',
      employee_id: EMP,
      location_id: LOC,
      days_requested: 2,
    });
    expect(second.status).toBe(TimeOffRequestStatus.APPROVED);
    expect(second.id).toBe(first.id);

    // Balance should only have been decremented once
    const balance = await timeOffService.getBalance(EMP, LOC);
    expect(balance.balance).toBe(8);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Reconciliation — fixes drift
  // ────────────────────────────────────────────────────────────────────────────

  it('reconciliation overwrites stale local balance with HCM truth', async () => {
    hcm.seedBalance(EMP, LOC, 10);
    await reconciliationService.reconcileFromHcm();

    // Manually corrupt local balance to simulate drift
    const repo = dataSource.getRepository(EmployeeBalance);
    const bal = await repo.findOne({ where: { employee_id: EMP, location_id: LOC } });
    bal.balance = 999;
    await repo.save(bal);

    expect((await timeOffService.getBalance(EMP, LOC)).balance).toBe(999);

    // HCM still has 10 — reconcile should restore it
    await reconciliationService.reconcileFromHcm();
    expect((await timeOffService.getBalance(EMP, LOC)).balance).toBe(10);
  });

  it('push-reconcile from payload creates missing records', async () => {
    const result = await reconciliationService.reconcileFromPayload({
      balances: [
        { employee_id: 'emp-new', location_id: 'loc-x', balance: 15 },
        { employee_id: 'emp-new2', location_id: 'loc-x', balance: 20 },
      ],
    });

    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);

    const b = await timeOffService.getBalance('emp-new', 'loc-x');
    expect(b.balance).toBe(15);
  });

  it('reconcile detects stale PENDING (orphaned) requests', async () => {
    hcm.seedBalance(EMP, LOC, 10);
    await reconciliationService.reconcileFromHcm();

    // Manually insert a PENDING request with old timestamp
    const repo = dataSource.getRepository(TimeOffRequest);
    const staleReq = repo.create({
      request_id: 'orphan-stale-01',
      employee_id: EMP,
      location_id: LOC,
      days_requested: 3,
      status: TimeOffRequestStatus.PENDING,
    });
    staleReq.created_at = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    await repo.save(staleReq);

    const result = await reconciliationService.reconcileFromHcm();
    expect(result.orphaned_requests_detected).toContain('orphan-stale-01');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Sequential requests drain balance correctly
  // ────────────────────────────────────────────────────────────────────────────

  it('sequential requests correctly drain local balance', async () => {
    hcm.seedBalance(EMP, LOC, 9);
    await reconciliationService.reconcileFromHcm();

    for (let i = 0; i < 3; i++) {
      const result = await timeOffService.requestTimeOff({
        request_id: `seq-${i}`,
        employee_id: EMP,
        location_id: LOC,
        days_requested: 3,
      });
      expect(result.status).toBe(TimeOffRequestStatus.APPROVED);
    }

    const balance = await timeOffService.getBalance(EMP, LOC);
    expect(balance.balance).toBe(0);

    await expect(
      timeOffService.requestTimeOff({
        request_id: 'seq-overflow',
        employee_id: EMP,
        location_id: LOC,
        days_requested: 1,
      }),
    ).rejects.toThrow(); // insufficient
  });
});
