export interface HcmValidateAndDeductRequest {
  request_id: string;
  employee_id: string;
  location_id: string;
  days_requested: number;
}

export interface HcmValidateAndDeductResponse {
  success: boolean;
  remaining_balance: number;
  message: string;
  hcm_transaction_id?: string;
}

export interface HcmBulkBalance {
  employee_id: string;
  location_id: string;
  balance: number;
}

export interface HcmBulkBalancesResponse {
  balances: HcmBulkBalance[];
  snapshot_at: string;
}

export const HCM_PROXY_TOKEN = 'HCM_PROXY';

export interface IHcmProxy {
  validateAndDeduct(
    request: HcmValidateAndDeductRequest,
  ): Promise<HcmValidateAndDeductResponse>;
  getBulkBalances(): Promise<HcmBulkBalancesResponse>;
}
