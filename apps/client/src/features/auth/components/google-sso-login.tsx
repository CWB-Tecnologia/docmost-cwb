import { useEffect, useRef } from "react";
import { Alert, Button, Divider, Stack } from "@mantine/core";
import { IconBrandGoogle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { getRedirectParam } from "@/lib/app-route.ts";
import { useWorkspacePublicDataQuery } from "@/features/workspace/queries/workspace-query.ts";
import useCurrentUser from "@/features/user/hooks/use-current-user.ts";

const AUTO_ATTEMPT_KEY = "docmost:googleSsoAutoAttempt";
const AUTO_ATTEMPT_TTL_MS = 5 * 60_000;

function loginUrl(): string {
  const returnTo = getRedirectParam() ?? "/home";
  return `/api/sso/google/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function recentlyAttempted(): boolean {
  try {
    const timestamp = Number(sessionStorage.getItem(AUTO_ATTEMPT_KEY));
    return (
      Number.isFinite(timestamp) && Date.now() - timestamp < AUTO_ATTEMPT_TTL_MS
    );
  } catch {
    return false;
  }
}

export function GoogleSsoLogin() {
  const { t } = useTranslation();
  const { data } = useWorkspacePublicDataQuery();
  const { data: currentUser } = useCurrentUser();
  const attemptedRef = useRef(false);
  const params = new URLSearchParams(window.location.search);
  const errorCode = params.get("ssoError");

  useEffect(() => {
    if (attemptedRef.current || !data?.googleSso?.enabled || !data.enforceSso) {
      return;
    }
    if (
      currentUser?.user ||
      params.has("logout") ||
      errorCode ||
      recentlyAttempted()
    ) {
      return;
    }
    attemptedRef.current = true;
    try {
      sessionStorage.setItem(AUTO_ATTEMPT_KEY, String(Date.now()));
    } catch {
      // Best effort only; private browsing may disable session storage.
    }
    window.location.assign(loginUrl());
  }, [currentUser, data, errorCode]);

  if (!data?.googleSso?.enabled) return null;

  return (
    <>
      {errorCode && (
        <Alert color="red" mb="sm" role="alert">
          {t("Google sign-in could not be completed. Please try again.")}
        </Alert>
      )}
      <Stack gap="sm">
        <Button
          component="a"
          href={loginUrl()}
          leftSection={<IconBrandGoogle size={18} />}
          variant="default"
          fullWidth
        >
          {data.googleSso.displayName}
        </Button>
      </Stack>
      {!data.enforceSso && (
        <Divider my="xs" label={t("OR")} labelPosition="center" />
      )}
    </>
  );
}
