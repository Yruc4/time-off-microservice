import {
  IsArray,
  ValidateNested,
  IsString,
  IsNumber,
  IsNotEmpty,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BalanceEntryDto {
  @IsString()
  @IsNotEmpty()
  employee_id: string;

  @IsString()
  @IsNotEmpty()
  location_id: string;

  @IsNumber()
  @Min(0)
  balance: number;
}

export class ReconcileDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BalanceEntryDto)
  balances: BalanceEntryDto[];
}
