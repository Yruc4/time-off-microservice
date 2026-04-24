import {
  HcmBulkBalancesResponse,
  HcmValidateAndDeductRequest,
  HcmValidateAndDeductResponse,
} from '../../domain/interfaces/hcm.interface';

/**
 * Production-style HCM adapter that makes real HTTP calls to the HCM system.
 * Used in the real-HTTP E2E test suite where a standalone mock HCM server
 * is spun up, satisfying the "real mock server" requirement from the spec.
 *
 * In production, replace `baseUrl` with the actual HCM base URL via config.
 */
export class HcmHttpService {
  constructor(private readonly baseUrl: string) {}

  async validateAndDeduct(
    request: HcmValidateAndDeductRequest,
  ): Promise<HcmValidateAndDeductResponse> {
    const res = await fetch(`${this.baseUrl}/deduct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`HCM HTTP error ${res.status}: ${await res.text()}`);
    }

    return res.json() as Promise<HcmValidateAndDeductResponse>;
  }

  async getBulkBalances(): Promise<HcmBulkBalancesResponse> {
    const res = await fetch(`${this.baseUrl}/balances`);

    if (!res.ok) {
      throw new Error(`HCM HTTP error ${res.status}: ${await res.text()}`);
    }

    return res.json() as Promise<HcmBulkBalancesResponse>;
  }
}
