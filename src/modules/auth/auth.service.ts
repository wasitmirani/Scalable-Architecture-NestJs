import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './../users/entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { Helpers } from '../../common/utils/helpers';
import { ApiResponse, ApiResponseData } from '../../common/utils/api.response';
import { 
  UnauthorizedException, 
  ConflictException, 
  BusinessException,
  NotFoundException 
} from '../../common/exceptions/custom.exceptions';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    private jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto): Promise<ApiResponseData> {
    try {
      const { email, password, name } = registerDto;

      // Validate email format
      if (!Helpers.isValidEmail(email)) {
        throw new BusinessException('Invalid email format', 'INVALID_EMAIL');
      }

      // Validate password strength
      if (!Helpers.isStrongPassword(password)) {
        throw new BusinessException(
          'Password must be at least 8 characters long and contain uppercase, lowercase, numbers, and special characters',
          'WEAK_PASSWORD'
        );
      }

      // Check if user already exists
      const existingUser = await this.usersRepository.findOne({ 
        where: [{ email }] 
      });
      
      if (existingUser) {
        throw new ConflictException('User with this email already exists');
      }

      // Create user
      const user = this.usersRepository.create({
        email,
        password,
        name,
      });

      await this.usersRepository.save(user);

      // Return user without password
      const { password: _, ...userWithoutPassword } = user;

      return ApiResponse.created(
        { user: userWithoutPassword },
        'User registered successfully'
      );
    } catch (error) {
      if (error instanceof BusinessException || 
          error instanceof ConflictException) {
        throw error;
      }
      
      // Log unexpected errors
      console.error('Registration error:', error);
      throw new BusinessException('Registration failed', 'REGISTRATION_ERROR');
    }
  }

  async login(loginDto: LoginDto): Promise<ApiResponseData> {
    try {
      const { email, password } = loginDto;

      // Validate input
      if (!email || !password) {
        return ApiResponse.error('Email and password are required');
      }

      // Find user by email
      const user = await this.usersRepository.findOne({ 
        where: { email } 
      });
      
      if (!user) {
        return ApiResponse.unauthorized('Invalid email or password');
      }

      // Check if account is locked (you can implement this logic)
      if (user['isLocked']) {
        return ApiResponse.unauthorized('Account is temporarily locked');
      }

      // Validate password
      const isPasswordValid = await user.comparePassword(password);
      console.log('isPasswordValid', isPasswordValid);
      if (!isPasswordValid) {
        // Increment failed login attempts (you can implement this)
        return ApiResponse.unauthorized('Invalid email or password');
      }

      // Reset failed login attempts on successful login
      // await this.usersRepository.update(user.id, { failedLoginAttempts: 0 });

      // Generate JWT tokens
      const payload = { 
        email: user.email, 
        sub: user.id,
        username: user.userName 
      };
      
      const access_token = this.jwtService.sign(payload, { expiresIn: process.env.JWT_EXPIRES_IN  as any || '15m' });
      const refresh_token = this.jwtService.sign(payload, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN  as any || '7d' });

      // Return user data without password
      const { password: _, ...userWithoutPassword } = user;

      return ApiResponse.success(
        {
          user: userWithoutPassword,
          access_token,
          refresh_token,
        },
        'Login successful'
      );
    } catch (error) {
      if (error instanceof BusinessException) {
        throw error;
      }
      
      console.error('Login error:', error);
      throw new BusinessException('Login failed', 'LOGIN_ERROR');
    }
  }

  async validateUserById(userId: number): Promise<User> {
    try {
      const user = await this.usersRepository.findOne({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException('User');
      }
      return user;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BusinessException('User validation failed', 'USER_VALIDATION_ERROR');
    }
  }

  async refreshToken(refreshToken: string): Promise<ApiResponseData> {
    try {
      if (!refreshToken) {
        throw new BusinessException('Refresh token is required', 'MISSING_REFRESH_TOKEN');
      }

      // Verify refresh token
      const payload = this.jwtService.verify(refreshToken);
      const user = await this.validateUserById(payload.sub);

      // Generate new access token
      const newPayload = { 
        email: user.email, 
        sub: user.id,
      };
      
      const access_token = this.jwtService.sign(newPayload, { expiresIn: process.env.JWT_EXPIRES_IN  as any || '15m' });

      return ApiResponse.success(
        { access_token },
        'Token refreshed successfully'
      );
    } catch (error) {
      if (error.name === 'JsonWebTokenError') {
        throw new UnauthorizedException('Invalid refresh token');
      }
      if (error.name === 'TokenExpiredError') {
        throw new UnauthorizedException('Refresh token expired');
      }
      throw new BusinessException('Token refresh failed', 'TOKEN_REFRESH_ERROR');
    }
  }
}