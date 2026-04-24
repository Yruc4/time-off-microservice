import { Module } from '@nestjs/common';
import { MockHcmService } from './mock-hcm.service';
import { HcmProxyService } from './hcm-proxy.service';

@Module({
  providers: [MockHcmService, HcmProxyService],
  exports: [HcmProxyService, MockHcmService],
})
export class HcmProxyModule {}
