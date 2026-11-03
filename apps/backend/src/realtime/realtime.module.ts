import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { sessionIdleSeconds } from '../auth/session';
import { BranchAccessService } from '../common/services/branch-access.service';
import { RealtimeGateway } from './realtime.gateway';

@Global()
@Module({
  imports: [
    // Separate registration from AuthModule's (not exported there) — same
    // secret/factory shape, so a token issued at login verifies identically
    // here.
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
  providers: [RealtimeGateway, BranchAccessService],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
