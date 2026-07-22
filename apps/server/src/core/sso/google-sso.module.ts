import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { GoogleOidcClient } from './google-oidc.client';
import { GoogleSsoController } from './google-sso.controller';
import { GoogleSsoService } from './google-sso.service';

@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [GoogleSsoController],
  providers: [GoogleOidcClient, GoogleSsoService],
})
export class GoogleSsoModule {}
