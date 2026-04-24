import {
  Injectable,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { EmployeeBalance } from '../../domain/entities/employee-balance.entity';
import {
  TimeOffRequest,
  TimeOffRequestStatus,
} from '../../domain/entities/time-off-request.entity';
import { HcmProxyService } from '../hcm-proxy/hcm-proxy.service';
import { RequestTimeOffDto } from '../../common/dto/request-time-off.dto';

@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);

  constructor(
    @InjectRepository(EmployeeBalance)
    private readonly balanceRepo: Repository<EmployeeBalance>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly hcmProxy: HcmProxyService,
    private readonly dataSource: DataSource,
  ) {}

  async requestTimeOff(dto: RequestTimeOffDto): Promise<TimeOffRequest> {
    const { request_id, employee_id, location_id, days_requested } = dto;

    // ── Step 1: Idempotency gate ─────────────────────────────────────────────
    // Return the original result immediately; never re-process.
    const existing = await this.requestRepo.findOne({ where: { request_id } });
    if (existing) {
      this.logger.log(
        `Idempotent replay: request_id=${request_id} status=${existing.status}`,
      );
      return existing;
    }

    // ── Step 2: Fast-fail on local cache ────────────────────────────────────
    // Avoid burning an HCM API call when we already know the balance is zero.
    const localBalance = await this.balanceRepo.findOne({
      where: { employee_id, location_id },
    });

    if (!localBalance) {
      throw new BadRequestException(
        `No balance record found for employee=${employee_id} location=${location_id}. ` +
          `Run a reconciliation pull first.`,
      );
    }

    if (localBalance.balance < days_requested) {
      throw new BadRequestException(
        `Local cache: insufficient balance. Available=${localBalance.balance}, requested=${days_requested}`,
      );
    }

    // ── Step 3: Persist PENDING before HCM call ─────────────────────────────
    // Writing PENDING first ensures idempotency even if the process crashes
    // after HCM responds but before our APPROVED commit lands.
    const pendingRequest = this.requestRepo.create({
      request_id,
      employee_id,
      location_id,
      days_requested,
      status: TimeOffRequestStatus.PENDING,
    });
    await this.requestRepo.save(pendingRequest);

    // ── Step 4: Call HCM (the real source of truth) ──────────────────────────
    let hcmResponse: Awaited<ReturnType<HcmProxyService['validateAndDeduct']>>;
    try {
      hcmResponse = await this.hcmProxy.validateAndDeduct({
        request_id,
        employee_id,
        location_id,
        days_requested,
      });
    } catch (hcmError) {
      pendingRequest.status = TimeOffRequestStatus.FAILED;
      pendingRequest.failure_reason = `HCM unreachable: ${hcmError.message}`;
      await this.requestRepo.save(pendingRequest);
      throw new ServiceUnavailableException(
        'HCM system is currently unavailable. Your request is recorded as FAILED. Please retry.',
      );
    }

    if (!hcmResponse.success) {
      pendingRequest.status = TimeOffRequestStatus.FAILED;
      pendingRequest.hcm_response = JSON.stringify(hcmResponse);
      pendingRequest.failure_reason = hcmResponse.message;
      await this.requestRepo.save(pendingRequest);
      throw new BadRequestException(hcmResponse.message);
    }

    // ── Step 5: Dual-write — update local cache + mark APPROVED atomically ───
    // If this transaction fails after HCM already deducted, the request stays
    // PENDING. ReconciliationService detects stale PENDING records and the
    // next reconcile-from-HCM will correct local balance drift.
    try {
      await this.dataSource.transaction(async (manager) => {
        const fresh = await manager.findOne(EmployeeBalance, {
          where: { employee_id, location_id },
        });

        if (!fresh) {
          throw new Error('Balance row vanished inside transaction');
        }

        fresh.balance -= days_requested;
        // TypeORM version column auto-increments; if another writer beat us,
        // the UPDATE WHERE version=N touches 0 rows → OptimisticLockVersionMismatchError.
        await manager.save(EmployeeBalance, fresh);

        pendingRequest.status = TimeOffRequestStatus.APPROVED;
        pendingRequest.hcm_response = JSON.stringify(hcmResponse);
        await manager.save(TimeOffRequest, pendingRequest);
      });
    } catch (dbError) {
      // ORPHANED STATE: HCM deducted but local commit failed.
      // The PENDING record acts as the audit trail for reconciliation.
      this.logger.error(
        `ORPHAN DETECTED request_id=${request_id}: HCM approved but local commit failed. ` +
          `Will be corrected by next reconciliation run. error=${dbError.message}`,
      );

      const isOptimisticLock =
        dbError.constructor?.name === 'OptimisticLockVersionMismatchError' ||
        dbError.message?.includes('optimistic lock');

      if (isOptimisticLock) {
        throw new ConflictException(
          'A concurrent request modified this balance. Please retry.',
        );
      }

      throw new ServiceUnavailableException(
        `HCM approved your request but local commit failed. ` +
          `Reference request_id=${request_id} for support or retry.`,
      );
    }

    return this.requestRepo.findOne({ where: { request_id } });
  }

  async getBalance(
    employee_id: string,
    location_id: string,
  ): Promise<EmployeeBalance> {
    const balance = await this.balanceRepo.findOne({
      where: { employee_id, location_id },
    });
    if (!balance) {
      throw new BadRequestException(
        `No balance found for employee=${employee_id} location=${location_id}`,
      );
    }
    return balance;
  }

  async getRequest(request_id: string): Promise<TimeOffRequest> {
    const req = await this.requestRepo.findOne({ where: { request_id } });
    if (!req) {
      throw new BadRequestException(`No request found for request_id=${request_id}`);
    }
    return req;
  }
}
