import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { TimeOffService } from './time-off.service';
import { ReconciliationService } from './reconciliation.service';
import { RequestTimeOffDto } from '../../common/dto/request-time-off.dto';
import { ReconcileDto } from '../../common/dto/reconcile.dto';

@Controller('time-off')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class TimeOffController {
  constructor(
    private readonly timeOffService: TimeOffService,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  /** Submit a time-off request. Idempotent on request_id. */
  @Post('request')
  @HttpCode(HttpStatus.CREATED)
  async requestTimeOff(@Body() dto: RequestTimeOffDto) {
    const data = await this.timeOffService.requestTimeOff(dto);
    return { success: true, data };
  }

  /** Fetch local cached balance for an employee at a location. */
  @Get('balance/:employee_id/:location_id')
  async getBalance(
    @Param('employee_id') employee_id: string,
    @Param('location_id') location_id: string,
  ) {
    const data = await this.timeOffService.getBalance(employee_id, location_id);
    return { success: true, data };
  }

  /** Look up an existing request by its idempotency key. */
  @Get('request/:request_id')
  async getRequest(@Param('request_id') request_id: string) {
    const data = await this.timeOffService.getRequest(request_id);
    return { success: true, data };
  }

  /**
   * Overwrite local balances from a caller-supplied HCM snapshot.
   * Used when HCM pushes its corpus to us (webhook / batch job).
   */
  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  async reconcileFromPayload(@Body() dto: ReconcileDto) {
    const data = await this.reconciliationService.reconcileFromPayload(dto);
    return { success: true, data };
  }

  /**
   * Pull the full corpus from HCM and overwrite local balances.
   * Trigger this after anniversaries, manual HCM edits, or incidents.
   */
  @Post('reconcile/pull-from-hcm')
  @HttpCode(HttpStatus.OK)
  async reconcileFromHcm() {
    const data = await this.reconciliationService.reconcileFromHcm();
    return { success: true, data };
  }
}
