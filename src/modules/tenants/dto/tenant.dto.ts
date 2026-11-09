import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Validate,
} from 'class-validator';
import type { ValidatorConstraintInterface } from 'class-validator';

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone').concat('UTC'));

class IsTimezone implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === 'string' && TIMEZONES.has(value);
  }
  defaultMessage() {
    return 'timezone must be a valid IANA time zone';
  }
}

export class CreateTenantDto {
  @IsString()
  @Length(2, 120)
  name: string;
}

export class UpdateTenantDto {
  @IsString()
  @Length(2, 120)
  name: string;
}

export class UpdateTenantSettingsDto {
  @IsOptional()
  @Validate(IsTimezone)
  timezone?: string;

  @IsOptional()
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/, {
    message: 'locale must look like "en" or "en-US"',
  })
  locale?: string;
}

export class UpdateMemberDto {
  @IsOptional()
  @IsUUID()
  roleId?: string;

  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';
}
