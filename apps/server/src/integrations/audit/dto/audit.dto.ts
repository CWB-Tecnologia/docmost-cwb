import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AuditListDto {
  @IsOptional()
  @IsString()
  event?: string;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsString()
  resourceType?: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AuditExportDto extends AuditListDto {
  @IsOptional()
  @IsIn(['csv', 'json'])
  format?: 'csv' | 'json';
}

export class AuditRetentionUpdateDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  auditRetentionDays: number;
}

export class AuditVerifyDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fromSeq?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toSeq?: number;
}
