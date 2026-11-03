import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { sessionIdleSeconds } from './session';
import { PassportModule } from '@nestjs/passport';
import { AuditModule } from '../audit/audit.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { SessionService } from './session.service';
import { TwoFactorService } from './two-factor.service';

@Module({
  imports: [
    PassportModule,
    AuditModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: sessionIdleSeconds(config),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, TwoFactorService, SessionService],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
