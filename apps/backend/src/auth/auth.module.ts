import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { sessionIdleSeconds } from './session';
import { PassportModule } from '@nestjs/passport';
import { AuditModule } from '../audit/audit.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { PasswordCheckService } from './password-check.service';
import { SessionService } from './session.service';
import { TwoFactorService } from './two-factor.service';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';
import { AuthTokensService } from './tokens/auth-tokens.service';

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
  controllers: [AuthController, PasswordResetController],
  providers: [
    AuthService,
    JwtStrategy,
    TwoFactorService,
    SessionService,
    PasswordCheckService,
    AuthTokensService,
    PasswordResetService,
  ],
  exports: [
    AuthService,
    SessionService,
    PasswordCheckService,
    AuthTokensService,
  ],
})
export class AuthModule {}
