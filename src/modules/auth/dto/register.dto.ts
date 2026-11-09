import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsStrongPassword,
  Length,
  MaxLength,
} from 'class-validator';

export const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export const PASSWORD_RULES = {
  minLength: 8,
  minLowercase: 1,
  minUppercase: 1,
  minNumbers: 1,
  minSymbols: 1,
};
export const PASSWORD_MESSAGE =
  'Password must be at least 8 characters and include uppercase, lowercase, number and symbol';

export class RegisterDto {
  @IsString()
  @Length(2, 120)
  name: string;

  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  /** bcrypt only uses the first 72 bytes, so longer passwords are rejected. */
  @IsStrongPassword(PASSWORD_RULES, { message: PASSWORD_MESSAGE })
  @MaxLength(64)
  password: string;

  @IsString()
  @Length(2, 120)
  workspaceName: string;
}
