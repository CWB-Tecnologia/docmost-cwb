import { Injectable } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

@Injectable()
export class AuthCookieService {
  constructor(private readonly environmentService: EnvironmentService) {}

  setAuthCookie(res: FastifyReply, token: string): void {
    res.setCookie('authToken', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environmentService.getCookieExpiresIn(),
      secure: this.environmentService.isHttps(),
    });
  }
}
