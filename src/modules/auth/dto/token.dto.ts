import { IsString, Length } from 'class-validator';

export class RefreshTokenDto {
  @IsString()
  @Length(20, 100)
  refreshToken: string;
}

export class VerifyEmailDto {
  @IsString()
  @Length(20, 100)
  token: string;
}
