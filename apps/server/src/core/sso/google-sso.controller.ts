import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { GoogleSsoError, GoogleSsoService } from './google-sso.service';
import {
  GOOGLE_SSO_TRANSACTION_COOKIE,
  GOOGLE_SSO_TRANSACTION_TTL_MS,
} from './google-sso.util';

@Public()
@Controller('sso/google')
export class GoogleSsoController {
  constructor(
    private readonly googleSsoService: GoogleSsoService,
    private readonly environmentService: EnvironmentService,
  ) {}

  @Get('login')
  async login(
    @AuthWorkspace() workspace: Workspace,
    @Query('returnTo') returnTo: string | undefined,
    @Res() response: FastifyReply,
  ) {
    try {
      const login = await this.googleSsoService.createLogin(
        workspace,
        returnTo,
      );
      response.setCookie(GOOGLE_SSO_TRANSACTION_COOKIE, login.cookie, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/api/sso/google',
        secure: this.environmentService.isHttps(),
        maxAge: Math.floor(GOOGLE_SSO_TRANSACTION_TTL_MS / 1000),
      });
      return response.redirect(login.url.toString());
    } catch {
      return response.redirect('/login?ssoError=unavailable');
    }
  }

  @Get('callback')
  async callback(
    @AuthWorkspace() workspace: Workspace,
    @Req() request: FastifyRequest,
    @Res() response: FastifyReply,
  ) {
    const cookie = request.cookies[GOOGLE_SSO_TRANSACTION_COOKIE];
    response.clearCookie(GOOGLE_SSO_TRANSACTION_COOKIE, {
      path: '/api/sso/google',
    });

    try {
      const currentUrl = new URL(
        request.url,
        this.environmentService.getAppUrl(),
      );
      const returnTo = await this.googleSsoService.completeLogin(
        workspace,
        currentUrl,
        cookie,
        response,
      );
      return response.redirect(returnTo);
    } catch (error) {
      const code =
        error instanceof GoogleSsoError ? error.code : 'authentication_failed';
      return response.redirect(`/login?ssoError=${encodeURIComponent(code)}`);
    }
  }
}
