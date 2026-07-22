import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { WorkspaceService } from '../workspace/services/workspace.service';
import { SessionService } from '../session/session.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AuthCookieService } from '../auth/services/auth-cookie.service';
import { GoogleIdentityClaims, GoogleOidcClient } from './google-oidc.client';
import {
  GoogleSsoTransaction,
  sanitizeReturnTo,
  signGoogleSsoTransaction,
  verifyGoogleSsoTransaction,
} from './google-sso.util';
import { FastifyReply } from 'fastify';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { Inject } from '@nestjs/common';

export class GoogleSsoError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

@Injectable()
export class GoogleSsoService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
    private readonly oidcClient: GoogleOidcClient,
    private readonly userRepo: UserRepo,
    private readonly workspaceService: WorkspaceService,
    private readonly groupUserRepo: GroupUserRepo,
    private readonly sessionService: SessionService,
    private readonly authCookieService: AuthCookieService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  isEnabled(): boolean {
    return this.environmentService.isGoogleSsoEnabled();
  }

  async createLogin(
    workspace: Workspace,
    returnTo?: string,
  ): Promise<{ url: URL; cookie: string }> {
    this.assertEnabled();
    const domains = this.environmentService.getGoogleSsoAllowedDomains();
    const authorization = await this.oidcClient.createAuthorization(
      this.callbackUrl(),
      domains.length === 1 ? domains[0] : undefined,
    );
    const transaction: GoogleSsoTransaction = {
      state: authorization.state,
      nonce: authorization.nonce,
      codeVerifier: authorization.codeVerifier,
      workspaceId: workspace.id,
      returnTo: sanitizeReturnTo(returnTo),
      issuedAt: Date.now(),
    };
    return {
      url: authorization.url,
      cookie: signGoogleSsoTransaction(
        transaction,
        this.environmentService.getAppSecret(),
      ),
    };
  }

  async completeLogin(
    workspace: Workspace,
    currentUrl: URL,
    cookie: string | undefined,
    response: FastifyReply,
  ): Promise<string> {
    this.assertEnabled();
    const transaction = verifyGoogleSsoTransaction(
      cookie,
      this.environmentService.getAppSecret(),
    );
    if (!transaction || transaction.workspaceId !== workspace.id) {
      throw new GoogleSsoError('invalid_request');
    }

    let claims: GoogleIdentityClaims;
    try {
      claims = await this.oidcClient.exchangeCode(currentUrl, transaction);
    } catch {
      throw new GoogleSsoError('authentication_failed');
    }
    this.validateClaims(claims);

    const { user, userCreated, providerCreated, providerId } =
      await this.resolveUser(workspace, claims);
    const authToken = await this.sessionService.createSessionAndToken(user);
    this.authCookieService.setAuthCookie(response, authToken);

    if (providerCreated) {
      await this.auditService.logWithContext(
        {
          event: AuditEvent.SSO_PROVIDER_CREATED,
          resourceType: AuditResource.SSO_PROVIDER,
          resourceId: providerId,
          metadata: { source: 'environment', provider: 'google' },
        },
        { workspaceId: workspace.id, actorType: 'system' },
      );
    }
    if (userCreated) {
      await this.auditService.logWithContext(
        {
          event: AuditEvent.USER_CREATED,
          resourceType: AuditResource.USER,
          resourceId: user.id,
          changes: {
            after: { name: user.name, email: user.email, role: user.role },
          },
          metadata: { source: 'google_sso' },
        },
        { workspaceId: workspace.id, actorId: user.id, actorType: 'user' },
      );
    }
    await this.auditService.logWithContext(
      {
        event: AuditEvent.USER_LOGIN,
        resourceType: AuditResource.USER,
        resourceId: user.id,
        metadata: { method: 'google', mfaAuthority: 'google_workspace' },
      },
      { workspaceId: workspace.id, actorId: user.id, actorType: 'user' },
    );

    return transaction.returnTo;
  }

  private async resolveUser(
    workspace: Workspace,
    claims: Required<Pick<GoogleIdentityClaims, 'sub' | 'email'>> &
      GoogleIdentityClaims,
  ): Promise<{
    user: User;
    userCreated: boolean;
    providerCreated: boolean;
    providerId: string;
  }> {
    return executeTx(this.db, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'google-sso:' + workspace.id}))`.execute(
        trx,
      );

      let provider = await trx
        .selectFrom('authProviders')
        .selectAll()
        .where('workspaceId', '=', workspace.id)
        .where('type', '=', 'google')
        .where('deletedAt', 'is', null)
        .orderBy('createdAt', 'asc')
        .executeTakeFirst();
      let providerCreated = false;
      const providerValues = {
        name: this.environmentService.getGoogleSsoDisplayName(),
        allowSignup: this.environmentService.isGoogleSsoSignupAllowed(),
        isEnabled: true,
      };

      if (!provider) {
        provider = await trx
          .insertInto('authProviders')
          .values({
            ...providerValues,
            type: 'google',
            workspaceId: workspace.id,
            creatorId: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        providerCreated = true;
      } else {
        await trx
          .updateTable('authProviders')
          .set({ ...providerValues, updatedAt: new Date() })
          .where('id', '=', provider.id)
          .execute();
      }

      await sql`SELECT pg_advisory_xact_lock(hashtext(${'google-identity:' + provider.id + ':' + claims.sub}))`.execute(
        trx,
      );

      const account = await trx
        .selectFrom('authAccounts')
        .selectAll()
        .where('authProviderId', '=', provider.id)
        .where('providerUserId', '=', claims.sub)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();

      let user = account
        ? await this.userRepo.findById(account.userId, workspace.id, { trx })
        : await this.userRepo.findByEmail(claims.email, workspace.id, { trx });
      let userCreated = false;

      if (user?.deletedAt || user?.deactivatedAt) {
        throw new ForbiddenException('User is inactive');
      }

      if (!user) {
        if (!this.environmentService.isGoogleSsoSignupAllowed()) {
          throw new ForbiddenException('Google SSO signup is disabled');
        }
        user = await this.userRepo.insertUser(
          {
            email: claims.email,
            name: claims.name,
            avatarUrl: claims.picture,
            password: randomBytes(32).toString('base64url'),
            emailVerifiedAt: new Date(),
            hasGeneratedPassword: true,
            workspaceId: workspace.id,
          },
          trx,
        );
        userCreated = true;
        await this.workspaceService.addUserToWorkspace(
          user.id,
          workspace.id,
          undefined,
          trx,
        );
        await this.groupUserRepo.addUserToDefaultGroup(
          user.id,
          workspace.id,
          trx,
        );
        user = await this.userRepo.findById(user.id, workspace.id, { trx });
      }

      if (!account) {
        await trx
          .insertInto('authAccounts')
          .values({
            userId: user.id,
            providerUserId: claims.sub,
            authProviderId: provider.id,
            workspaceId: workspace.id,
          })
          .execute();
      } else if (account.userId !== user.id) {
        throw new UnauthorizedException('Google identity mismatch');
      }

      await trx
        .updateTable('users')
        .set({ lastLoginAt: new Date(), updatedAt: new Date() })
        .where('id', '=', user.id)
        .where('workspaceId', '=', workspace.id)
        .execute();
      user.lastLoginAt = new Date();

      return { user, userCreated, providerCreated, providerId: provider.id };
    });
  }

  private validateClaims(
    claims: GoogleIdentityClaims,
  ): asserts claims is Required<Pick<GoogleIdentityClaims, 'sub' | 'email'>> &
    GoogleIdentityClaims {
    if (!claims.sub || !claims.email || claims.email_verified !== true) {
      throw new UnauthorizedException('Google identity is not verified');
    }
    const hostedDomain = claims.hd?.toLowerCase();
    if (
      !hostedDomain ||
      !this.environmentService
        .getGoogleSsoAllowedDomains()
        .includes(hostedDomain)
    ) {
      throw new ForbiddenException('Google Workspace domain is not allowed');
    }
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new BadRequestException('Google SSO is disabled');
    }
  }

  private callbackUrl(): string {
    return `${this.environmentService.getAppUrl()}/api/sso/google/callback`;
  }
}
