import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmployeeBalance } from '../../domain/entities/employee-balance.entity';
import { TimeOffRequest } from '../../domain/entities/time-off-request.entity';
import { HcmProxyModule } from '../hcm-proxy/hcm-proxy.module';
import { TimeOffController } from './time-off.controller';
import { TimeOffService } from './time-off.service';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([EmployeeBalance, TimeOffRequest]),
    HcmProxyModule,
  ],
  controllers: [TimeOffController],
  providers: [TimeOffService, ReconciliationService],
})
export class TimeOffModule {}
