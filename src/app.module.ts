import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER } from '@nestjs/core';
import { EmployeeBalance } from './domain/entities/employee-balance.entity';
import { TimeOffRequest } from './domain/entities/time-off-request.entity';
import { TimeOffModule } from './modules/time-off/time-off.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'sqljs',
      location: 'time_off.db',
      autoSave: true,
      useLocalForage: false,
      entities: [EmployeeBalance, TimeOffRequest],
      synchronize: true,
      logging: false,
    }),
    TimeOffModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
