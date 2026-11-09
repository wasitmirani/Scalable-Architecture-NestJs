import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  IsStrongPassword,
  Length,
  MaxLength,
} from 'class-validator';
import {
  normalizeEmail,
  PASSWORD_MESSAGE,
  PASSWORD_RULES,
} from './register.dto';

export class ForgotPasswordDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class ResetPasswordDto {
  @IsString()
  @Length(20, 100)
  token: string;

  @IsStrongPassword(PASSWORD_RULES, { message: PASSWORD_MESSAGE })
  @MaxLength(64)
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword: string;

  @IsStrongPassword(PASSWORD_RULES, { message: PASSWORD_MESSAGE })
  @MaxLength(64)
  newPassword: string;
}
