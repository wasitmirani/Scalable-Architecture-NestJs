import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { UserOnly } from '../../common/decorators/roles.decorator';
import { CurrentUser, ReqMeta } from '../../common/decorators/user.decorator';
import type { Principal, RequestMeta } from '../../common/types/principal';
import { ApiResponse } from '../../common/utils/api.response';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  ResetPasswordDto,
} from './dto/password.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto, VerifyEmailDto } from './dto/token.dto';

type UserPrincipal = Extract<Principal, { type: 'user' }>;

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto, @ReqMeta() meta: RequestMeta) {
    return ApiResponse.created(
      await this.auth.register(dto, meta),
      'Account created',
    );
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @ReqMeta() meta: RequestMeta) {
    return ApiResponse.success(
      await this.auth.login(dto, meta),
      'Login successful',
    );
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshTokenDto, @ReqMeta() meta: RequestMeta) {
    return ApiResponse.success(
      await this.auth.refresh(dto.refreshToken, meta),
      'Token refreshed',
    );
  }

  @Post('logout')
  @HttpCode(200)
  @UserOnly()
  async logout(
    @CurrentUser() user: UserPrincipal,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.auth.logout(user, meta);
    return ApiResponse.success(null, 'Logged out');
  }

  @Get('me')
  @UserOnly()
  async me(@CurrentUser() user: UserPrincipal) {
    return ApiResponse.success(
      await this.auth.profile(user.userId),
      'Profile fetched',
    );
  }

  @Get('sessions')
  @UserOnly()
  async sessions(@CurrentUser() user: UserPrincipal) {
    return ApiResponse.success(
      await this.auth.listSessions(user),
      'Sessions fetched',
    );
  }

  @Delete('sessions/:id')
  @HttpCode(200)
  @UserOnly()
  async revokeSession(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.auth.revokeSession(user, id, meta);
    return ApiResponse.success(null, 'Session revoked');
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.auth.forgotPassword(dto.email, meta);
    return ApiResponse.success(
      null,
      'If an account exists for this email, a reset link has been sent',
      202,
    );
  }

  @Public()
  @Post('password/reset')
  @HttpCode(200)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.auth.resetPassword(dto, meta);
    return ApiResponse.success(
      null,
      'Password has been reset. Please sign in.',
    );
  }

  @Post('password/change')
  @HttpCode(200)
  @UserOnly()
  async changePassword(
    @CurrentUser() user: UserPrincipal,
    @Body() dto: ChangePasswordDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.auth.changePassword(user, dto, meta);
    return ApiResponse.success(
      null,
      'Password changed. Other sessions were signed out.',
    );
  }

  @Public()
  @Post('email/verify')
  @HttpCode(200)
  async verifyEmail(@Body() dto: VerifyEmailDto, @ReqMeta() meta: RequestMeta) {
    await this.auth.verifyEmail(dto.token, meta);
    return ApiResponse.success(null, 'Email verified');
  }

  @Post('email/resend')
  @HttpCode(202)
  @UserOnly()
  async resendVerification(@CurrentUser() user: UserPrincipal) {
    await this.auth.resendVerification(user);
    return ApiResponse.success(null, 'Verification email sent', 202);
  }
}
