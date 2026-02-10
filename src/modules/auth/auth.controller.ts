import { 
  Controller, 
  Post, 
  Body, 
  UsePipes, 
  Get, 
  UseGuards, 
  HttpCode,
  UseFilters,
  UseInterceptors
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { GetUser } from './get-user.decorator';
import { User } from '../users/entities/user.entity';
import { ValidationPipe } from '../../common/pipes/validation.pipe';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { BusinessException } from '../../common/exceptions/custom.exceptions';
import { ApiResponse } from '../../common/utils/api.response';

@Controller('auth')
@UseFilters(HttpExceptionFilter)
@UseInterceptors(ResponseInterceptor)
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @UsePipes(ValidationPipe)
  @HttpCode(201)
  async register(@Body() registerDto: RegisterDto) {
    return await this.authService.register(registerDto);
  }

  @Post('login')
  @UsePipes(ValidationPipe)
  @HttpCode(200)
  async login(@Body() loginDto: LoginDto) {
    return await this.authService.login(loginDto);
  }

  @Post('refresh-token')
  @HttpCode(200)
  async refreshToken(@Body('refresh_token') refreshToken: string) {
    if (!refreshToken) {
      throw new BusinessException('Refresh token is required', 'MISSING_REFRESH_TOKEN');
    }

    return await this.authService.refreshToken(refreshToken);
  }

  @Get('profile')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  getProfile(@GetUser() user: User) {
    // Remove password from response
    const { password, ...userWithoutPassword } = user;
    return ApiResponse.success(
      { user: userWithoutPassword },
      'Profile retrieved successfully'
    );
  }

  @Post('logout')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  async logout() {
    // In a real application, you might want to blacklist the token
    return ApiResponse.success(null, 'Logout successful');
  }

  
  @Post('debug-verify')
  async debugVerifyToken(@Body('token') token: string) {
    try {
      if (!token) {
        return { valid: false, error: 'No token provided' };
      }

      // Remove 'Bearer ' prefix if present
      const cleanToken = token.replace('Bearer ', '');
      
      const secret = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production-2024';
      const decoded = this.authService['jwtService'].verify(cleanToken);
      
      return {
        valid: true,
        decoded,
        secret: secret.substring(0, 10) + '...', // Only show first 10 chars for security
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message,
        secret: (process.env.JWT_SECRET || 'default').substring(0, 10) + '...',
      };
    }
  }

  @Get('check-env')
  checkEnv() {
    return {
      JWT_SECRET: process.env.JWT_SECRET ? 'SET' : 'NOT SET',
      JWT_SECRET_LENGTH: process.env.JWT_SECRET?.length || 0,
      NODE_ENV: process.env.NODE_ENV,
    };
  }
}