import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { EmployeeBalance } from '../../domain/entities/employee-balance.entity';
import {
  TimeOffRequest,
  TimeOffRequestStatus,
} from '../../domain/entities/time-off-request.entity';
import { HcmProxyService } from '../hcm-proxy/hcm-proxy.service';
import { ReconcileDto } from '../../common/dto/reconcile.dto';
import { HcmBulkBalance } from '../../domain/interfaces/hcm.interface';

export interface ReconciliationResult {
  processed: number;
  created: number;
  updated: number;
  orphaned_requests_detected: string[];
  snapshot_at: string;
}

const ORPHAN_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectRepository(EmployeeBalance)
    private readonly balanceRepo: Repository<EmployeeBalance>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly hcmProxy: HcmProxyService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Accept a full corpus from the caller (HCM pushes it, or ops triggers it).
   * Overwrites every local balance to match the HCM snapshot — this is the
   * canonical fix for drift caused by work anniversaries or manual HCM edits.
   */
  async reconcileFromPayload(dto: ReconcileDto): Promise<ReconciliationResult> {
    return this._reconcile(dto.balances, new Date().toISOString());
  }

  /**
   * Pull the full corpus from HCM ourselves and reconcile.
   * Useful for scheduled jobs and post-incident recovery.
   */
  async reconcileFromHcm(): Promise<ReconciliationResult> {
    const { balances, snapshot_at } = await this.hcmProxy.getBulkBalances();
    return this._reconcile(balances, snapshot_at);
  }

  private async _reconcile(
    balances: HcmBulkBalance[],
    snapshot_at: string,
  ): Promise<ReconciliationResult> {
    let created = 0;
    let updated = 0;
    const now = new Date();

    await this.dataSource.transaction(async (manager) => {
      for (const { employee_id, location_id, balance } of balances) {
        const existing = await manager.findOne(EmployeeBalance, {
          where: { employee_id, location_id },
        });

        if (existing) {
          existing.balance = balance;
          existing.last_synced_at = now;
          await manager.save(EmployeeBalance, existing);
          updated++;
        } else {
          const fresh = manager.create(EmployeeBalance, {
            employee_id,
            location_id,
            balance,
            last_synced_at: now,
          });
          await manager.save(EmployeeBalance, fresh);
          created++;
        }
      }
    });

    // Detect orphaned requests: PENDING records older than the TTL indicate
    // the dual-write failure scenario (HCM deducted, local commit crashed).
    const cutoff = new Date(Date.now() - ORPHAN_TTL_MS);
    const orphans = await this.requestRepo
      .createQueryBuilder('r')
      .where('r.status = :status', { status: TimeOffRequestStatus.PENDING })
      .andWhere('r.created_at < :cutoff', { cutoff })
      .getMany();

    if (orphans.length > 0) {
      this.logger.warn(
        `Orphan scan: ${orphans.length} stale PENDING request(s) detected. ` +
          `These may be HCM-approved requests whose local commit failed. ` +
          `IDs: ${orphans.map((r) => r.request_id).join(', ')}`,
      );
    }

    this.logger.log(
      `Reconciliation done: created=${created} updated=${updated} ` +
        `snapshot_at=${snapshot_at}`,
    );

    return {
      processed: balances.length,
      created,
      updated,
      orphaned_requests_detected: orphans.map((r) => r.request_id),
      snapshot_at,
    };
  }
}
