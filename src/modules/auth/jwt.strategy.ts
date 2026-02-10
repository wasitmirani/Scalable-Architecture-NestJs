import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET  || 'defaultSecret',
    });
  }

  async validate(payload: any) {
    // Validate if user still exists
    const user = await this.authService.validateUserById(payload.sub);
    if (!user) {
    //   throw new UnauthorizedException('User not found');
        throw new UnauthorizedException('Invalid token or user does not exist');
    }
    
    return {
      userId: payload.sub,
      email: payload.email,
      username: payload.username,
    };
  }
}