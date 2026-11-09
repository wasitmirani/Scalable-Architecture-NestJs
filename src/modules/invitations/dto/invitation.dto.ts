import { Transform } from 'class-transformer';
import { IsEmail, IsString, IsUUID, Length, MaxLength } from 'class-validator';

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateInvitationDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsUUID()
  roleId: string;
}

export class InvitationTokenDto {
  @IsString()
  @Length(20, 100)
  token: string;
}
