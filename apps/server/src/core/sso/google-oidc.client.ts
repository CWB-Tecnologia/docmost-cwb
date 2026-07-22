import { Injectable } from '@nestjs/common';
import { EnvironmentService } from '../../integrations/environment/environment.service';

type OpenIdClientModule = typeof import('openid-client');
type OidcConfiguration = import('openid-client').Configuration;

export type GoogleIdentityClaims = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
  picture?: string;
};

@Injectable()
export class GoogleOidcClient {
  private modulePromise?: Promise<OpenIdClientModule>;
  private configurationPromise?: Promise<OidcConfiguration>;

  constructor(private readonly environmentService: EnvironmentService) {}

  async createAuthorization(
    redirectUri: string,
    hostedDomain?: string,
  ): Promise<{
    url: URL;
    state: string;
    nonce: string;
    codeVerifier: string;
  }> {
    const oidc = await this.loadModule();
    const configuration = await this.getConfiguration();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();

    const parameters: Record<string, string> = {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    };
    if (hostedDomain) parameters.hd = hostedDomain;

    return {
      url: oidc.buildAuthorizationUrl(configuration, parameters),
      state,
      nonce,
      codeVerifier,
    };
  }

  async exchangeCode(
    currentUrl: URL,
    transaction: { state: string; nonce: string; codeVerifier: string },
  ): Promise<GoogleIdentityClaims> {
    const oidc = await this.loadModule();
    const configuration = await this.getConfiguration();
    const tokens = await oidc.authorizationCodeGrant(
      configuration,
      currentUrl,
      {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
      },
    );
    return (tokens.claims() ?? {}) as GoogleIdentityClaims;
  }

  private getConfiguration(): Promise<OidcConfiguration> {
    if (!this.configurationPromise) {
      this.configurationPromise = this.loadModule().then((oidc) =>
        oidc.discovery(
          new URL('https://accounts.google.com'),
          this.environmentService.getGoogleSsoClientId(),
          this.environmentService.getGoogleSsoClientSecret(),
        ),
      );
    }
    return this.configurationPromise;
  }

  private loadModule(): Promise<OpenIdClientModule> {
    if (!this.modulePromise) {
      const dynamicImport = Function(
        'specifier',
        'return import(specifier)',
      ) as (specifier: string) => Promise<OpenIdClientModule>;
      this.modulePromise = dynamicImport('openid-client');
    }
    return this.modulePromise;
  }
}
