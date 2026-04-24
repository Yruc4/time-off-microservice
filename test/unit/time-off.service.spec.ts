import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { TimeOffService } from '../../src/modules/time-off/time-off.service';
import { HcmProxyService } from '../../src/modules/hcm-proxy/hcm-proxy.service';
import { EmployeeBalance } from '../../src/domain/entities/employee-balance.entity';
import {
  TimeOffRequest,
  TimeOffRequestStatus,
} from '../../src/domain/entities/time-off-request.entity';

const EMPLOYEE = 'emp-001';
const LOCATION = 'loc-nyc';

function makeBalance(overrides: Partial<EmployeeBalance> = {}): EmployeeBalance {
  return Object.assign(new EmployeeBalance(), {
    id: 'bal-uuid',
    employee_id: EMPLOYEE,
    location_id: LOCATION,
    balance: 10,
    version: 1,
    last_synced_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  });
}

function makeRequest(
  status: TimeOffRequestStatus = TimeOffRequestStatus.PENDING,
): TimeOffRequest {
  return Object.assign(new TimeOffRequest(), {
    id: 'req-uuid',
    request_id: 'idem-001',
    employee_id: EMPLOYEE,
    location_id: LOCATION,
    days_requested: 3,
    status,
    hcm_response: null,
    failure_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

describe('TimeOffService (unit)', () => {
  let service: TimeOffService;
  let balanceRepo: jest.Mocked<any>;
  let requestRepo: jest.Mocked<any>;
  let hcmProxy: jest.Mocked<HcmProxyService>;
  let dataSource: jest.Mocked<DataSource>;

  beforeEach(async () => {
    balanceRepo = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };

    requestRepo = {
      findOne: jest.fn(),
      create: jest.fn((dto) => Object.assign(new TimeOffRequest(), dto)),
      save: jest.fn((entity) => Promise.resolve(entity)),
    };

    hcmProxy = {
      validateAndDeduct: jest.fn(),
      getBulkBalances: jest.fn(),
    } as any;

    // Minimal DataSource mock that executes the transaction callback synchronously
    dataSource = {
      transaction: jest.fn(async (cb) => {
        const manager = {
          findOne: jest.fn(),
          save: jest.fn((_, entity) => Promise.resolve(entity)),
          create: jest.fn((_, dto) => Object.assign({}, dto)),
        };
        manager.findOne.mockResolvedValue(makeBalance());
        return cb(manager);
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffService,
        { provide: getRepositoryToken(EmployeeBalance), useValue: balanceRepo },
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo },
        { provide: HcmProxyService, useValue: hcmProxy },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(TimeOffService);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Idempotency
  // ────────────────────────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('returns existing APPROVED request without calling HCM again', async () => {
      const approved = makeRequest(TimeOffRequestStatus.APPROVED);
      requestRepo.findOne.mockResolvedValue(approved);

      const result = await service.requestTimeOff({
        request_id: 'idem-001',
        employee_id: EMPLOYEE,
        location_id: LOCATION,
        days_requested: 3,
      });

      expect(result.status).toBe(TimeOffRequestStatus.APPROVED);
      expect(hcmProxy.validateAndDeduct).not.toHaveBeenCalled();
    });

    it('returns existing FAILED request without re-processing', async () => {
      const failed = makeRequest(TimeOffRequestStatus.FAILED);
      requestRepo.findOne.mockResolvedValueOnce(failed);

      const result = await service.requestTimeOff({
        request_id: 'idem-001',
        employee_id: EMPLOYEE,
        location_id: LOCATION,
        days_requested: 3,
      });

      expect(result.status).toBe(TimeOffRequestStatus.FAILED);
      expect(hcmProxy.validateAndDeduct).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Local cache fast-fail
  // ────────────────────────────────────────────────────────────────────────────

  describe('local balance fast-fail', () => {
    beforeEach(() => {
      requestRepo.findOne.mockResolvedValue(null); // no existing request
    });

    it('throws BadRequest when no balance record exists', async () => {
      balanceRepo.findOne.mockResolvedValue(null);

      await expect(
        service.requestTimeOff({
          request_id: 'new-001',
          employee_id: EMPLOYEE,
          location_id: LOCATION,
          days_requested: 3,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(hcmProxy.validateAndDeduct).not.toHaveBeenCalled();
    });

    it('throws BadRequest when local balance is insufficient', async () => {
      balanceRepo.findOne.mockResolvedValue(makeBalance({ balance: 2 }));

      await expect(
        service.requestTimeOff({
          request_id: 'new-002',
          employee_id: EMPLOYEE,
          location_id: LOCATION,
          days_requested: 5,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(hcmProxy.validateAndDeduct).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // HCM failure handling — local DB must stay consistent
  // ────────────────────────────────────────────────────────────────────────────

  describe('HCM failure handling', () => {
    beforeEach(() => {
      requestRepo.findOne.mockResolvedValue(null);
      balanceRepo.findOne.mockResolvedValue(makeBalance({ balance: 10 }));
    });

    it('marks request FAILED and throws ServiceUnavailable on HCM network error', async () => {
      hcmProxy.validateAndDeduct.mockRejectedValue(new Error('connection reset'));

      await expect(
        service.requestTimeOff({
          request_id: 'fail-001',
          employee_id: EMPLOYEE,
          location_id: LOCATION,
          days_requested: 3,
        }),
      ).rejects.toThrow(ServiceUnavailableException);

      // The request was saved as FAILED — we can verify save was called
      const savedArgs = requestRepo.save.mock.calls.map((c) => c[0]);
      const failedSave = savedArgs.find(
        (e) => e.status === TimeOffRequestStatus.FAILED,
      );
      expect(failedSave).toBeDefined();
      expect(failedSave.failure_reason).toMatch(/HCM unreachable/);
    });

    it('marks request FAILED and throws BadRequest when HCM denies (insufficient funds)', async () => {
      hcmProxy.validateAndDeduct.mockResolvedValue({
        success: false,
        remaining_balance: 2,
        message: 'Insufficient Funds: requested 3 days, only 2 available',
      });

      await expect(
        service.requestTimeOff({
          request_id: 'deny-001',
          employee_id: EMPLOYEE,
          location_id: LOCATION,
          days_requested: 3,
        }),
      ).rejects.toThrow(BadRequestException);

      const savedArgs = requestRepo.save.mock.calls.map((c) => c[0]);
      const failedSave = savedArgs.find(
        (e) => e.status === TimeOffRequestStatus.FAILED,
      );
      expect(failedSave).toBeDefined();
      expect(failedSave.failure_reason).toMatch(/Insufficient Funds/);
    });

    it('does NOT touch local balance when HCM denies', async () => {
      hcmProxy.validateAndDeduct.mockResolvedValue({
        success: false,
        remaining_balance: 0,
        message: 'Insufficient Funds',
      });

      await expect(
        service.requestTimeOff({
          request_id: 'deny-002',
          employee_id: EMPLOYEE,
          location_id: LOCATION,
          days_requested: 5,
        }),
      ).rejects.toThrow(BadRequestException);

      // DataSource.transaction must never have been called (no balance mutation)
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Happy path
  // ────────────────────────────────────────────────────────────────────────────

  describe('successful request', () => {
    it('returns APPROVED request and mutates local balance', async () => {
      requestRepo.findOne
        .mockResolvedValueOnce(null) // idempotency check
        .mockResolvedValueOnce(makeRequest(TimeOffRequestStatus.APPROVED)); // final fetch

      balanceRepo.findOne.mockResolvedValue(makeBalance({ balance: 10 }));

      hcmProxy.validateAndDeduct.mockResolvedValue({
        success: true,
        remaining_balance: 7,
        message: 'Balance deducted successfully',
        hcm_transaction_id: 'hcm-txn-abc',
      });

      const result = await service.requestTimeOff({
        request_id: 'ok-001',
        employee_id: EMPLOYEE,
        location_id: LOCATION,
        days_requested: 3,
      });

      expect(result.status).toBe(TimeOffRequestStatus.APPROVED);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Orphan detection — HCM approves but DB commit fails
  // ────────────────────────────────────────────────────────────────────────────

  describe('orphan scenario', () => {
    it('throws ServiceUnavailable when DB commit fails after HCM approval', async () => {
      requestRepo.findOne.mockResolvedValue(null);
      balanceRepo.findOne.mockResolvedValue(makeBalance({ balance: 10 }));

      hcmProxy.validateAndDeduct.mockResolvedValue({
        success: true,
        remaining_balance: 7,
        message: 'OK',
        hcm_transaction_id: 'hcm-txn-xyz',
      });

      dataSource.transaction = jest.fn().mockRejectedValue(
        new Error('SQLITE_BUSY: database is locked'),
      );

      await expect(
        service.requestTimeOff({
          request_id: 'orphan-001',
          employee_id: EMPLOYEE,
          location_id: LOCATION,
          days_requested: 3,
        }),
      ).rejects.toThrow(ServiceUnavailableException);

      // Request must remain as PENDING (not APPROVED, not deleted) for reconciliation
      const savedArgs = requestRepo.save.mock.calls.map((c) => c[0]);
      const pendingSave = savedArgs.find(
        (e) => e.status === TimeOffRequestStatus.PENDING,
      );
      expect(pendingSave).toBeDefined();
    });

    it('throws ConflictException on optimistic lock error', async () => {
      requestRepo.findOne.mockResolvedValue(null);
      balanceRepo.findOne.mockResolvedValue(makeBalance({ balance: 10 }));

      hcmProxy.validateAndDeduct.mockResolvedValue({
        success: true,
        remaining_balance: 5,
        message: 'OK',
        hcm_transaction_id: 'hcm-txn-lock',
      });

      const lockError = new Error('optimistic lock version mismatch');
      lockError.name = 'OptimisticLockVersionMismatchError';
      dataSource.transaction = jest.fn().mockRejectedValue(lockError);

      await expect(
        service.requestTimeOff({
          request_id: 'lock-001',
          employee_id: EMPLOYEE,
          location_id: LOCATION,
          days_requested: 5,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
