import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  IHcmProxy,
  HcmValidateAndDeductRequest,
  HcmValidateAndDeductResponse,
  HcmBulkBalancesResponse,
  HcmBulkBalance,
} from '../../domain/interfaces/hcm.interface';

interface InternalEntry {
  employee_id: string;
  location_id: string;
  balance: number;
}

/**
 * Simulates the external HCM system in-process.
 * In production, HcmProxyService would make HTTP calls instead.
 *
 * The HCM is the authoritative balance store; this mock preserves
 * that invariant so tests exercise real drift-correction scenarios.
 */
@Injectable()
export class MockHcmService implements IHcmProxy {
  private readonly store = new Map<string, InternalEntry>();
  private readonly processed = new Set<string>();
  private _failNextCall = false;

  private key(employee_id: string, location_id: string): string {
    return `${employee_id}::${location_id}`;
  }

  /** Test helper: pre-load a balance into the mock HCM. */
  seedBalance(employee_id: string, location_id: string, balance: number): void {
    this.store.set(this.key(employee_id, location_id), {
      employee_id,
      location_id,
      balance,
    });
  }

  /** Test helper: simulate a transient HCM network failure on the next call. */
  failNextCall(): void {
    this._failNextCall = true;
  }

  /** Test helper: wipe all state between tests. */
  reset(): void {
    this.store.clear();
    this.processed.clear();
    this._failNextCall = false;
  }

  async validateAndDeduct(
    request: HcmValidateAndDeductRequest,
  ): Promise<HcmValidateAndDeductResponse> {
    if (this._failNextCall) {
      this._failNextCall = false;
      throw new Error('HCM network timeout (simulated)');
    }

    const { request_id, employee_id, location_id, days_requested } = request;
    const k = this.key(employee_id, location_id);

    // HCM-side idempotency: re-submit of a processed request_id returns same answer.
    if (this.processed.has(request_id)) {
      const entry = this.store.get(k);
      return {
        success: true,
        remaining_balance: entry?.balance ?? 0,
        message: 'Already processed (idempotent replay)',
        hcm_transaction_id: `hcm-idem-${request_id}`,
      };
    }

    const entry = this.store.get(k);
    if (!entry) {
      return {
        success: false,
        remaining_balance: 0,
        message: `Employee ${employee_id} at location ${location_id} not found in HCM`,
      };
    }

    if (entry.balance < days_requested) {
      return {
        success: false,
        remaining_balance: entry.balance,
        message: `Insufficient Funds: requested ${days_requested} days, only ${entry.balance} available`,
      };
    }

    entry.balance -= days_requested;
    this.processed.add(request_id);

    return {
      success: true,
      remaining_balance: entry.balance,
      message: 'Balance deducted successfully',
      hcm_transaction_id: `hcm-txn-${uuidv4()}`,
    };
  }

  async getBulkBalances(): Promise<HcmBulkBalancesResponse> {
    const balances: HcmBulkBalance[] = Array.from(this.store.values()).map(
      ({ employee_id, location_id, balance }) => ({
        employee_id,
        location_id,
        balance,
      }),
    );

    return {
      balances,
      snapshot_at: new Date().toISOString(),
    };
  }
}
