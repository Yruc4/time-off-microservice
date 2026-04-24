import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  VersionColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';

@Entity('employee_balances')
@Unique(['employee_id', 'location_id'])
export class EmployeeBalance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'employee_id' })
  employee_id: string;

  @Column({ name: 'location_id' })
  location_id: string;

  @Column({ type: 'real', default: 0 })
  balance: number;

  /**
   * Incremented automatically by TypeORM on each save.
   * Used for optimistic locking: UPDATE ... WHERE version = N fails
   * if another writer already committed (version advanced past N).
   */
  @VersionColumn()
  version: number;

  @Column({ name: 'last_synced_at', nullable: true, type: 'datetime' })
  last_synced_at: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at: Date;
}
