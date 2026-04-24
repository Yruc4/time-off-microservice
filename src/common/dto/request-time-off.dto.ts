import { IsString, IsNumber, IsPositive, IsNotEmpty } from 'class-validator';

export class RequestTimeOffDto {
  @IsString()
  @IsNotEmpty()
  request_id: string;

  @IsString()
  @IsNotEmpty()
  employee_id: string;

  @IsString()
  @IsNotEmpty()
  location_id: string;

  @IsNumber()
  @IsPositive()
  days_requested: number;
}
