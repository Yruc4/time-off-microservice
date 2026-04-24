import { Injectable } from '@nestjs/common';
import { MockHcmService } from './mock-hcm.service';
import {
  HcmValidateAndDeductRequest,
  HcmValidateAndDeductResponse,
  HcmBulkBalancesResponse,
} from '../../domain/interfaces/hcm.interface';

/**
 * Adapter between the application and the HCM system.
 * Swap MockHcmService for an HttpService call to go live.
 */
@Injectable()
export class HcmProxyService {
  constructor(private readonly hcm: MockHcmService) {}

  async validateAndDeduct(
    request: HcmValidateAndDeductRequest,
  ): Promise<HcmValidateAndDeductResponse> {
    return this.hcm.validateAndDeduct(request);
  }

  async getBulkBalances(): Promise<HcmBulkBalancesResponse> {
    return this.hcm.getBulkBalances();
  }
}
