import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum TimeOffRequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  FAILED = 'FAILED',
}

@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Client-supplied idempotency key. Unique constraint ensures
   * duplicate submissions return the original result, never double-deduct.
   */
  @Index({ unique: true })
  @Column({ name: 'request_id' })
  request_id: string;

  @Column({ name: 'employee_id' })
  employee_id: string;

  @Column({ name: 'location_id' })
  location_id: string;

  @Column({ type: 'real', name: 'days_requested' })
  days_requested: number;

  @Column({ type: 'text', default: TimeOffRequestStatus.PENDING })
  status: TimeOffRequestStatus;

  @Column({ name: 'hcm_response', type: 'text', nullable: true })
  hcm_response: string | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failure_reason: string | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at: Date;
}
