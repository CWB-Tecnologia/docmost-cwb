import { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { Button } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui/empty-state.tsx";

export function KanbanErrorBoundary({
  resetKeys,
  children,
}: {
  resetKeys?: unknown[];
  children: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <ErrorBoundary
      resetKeys={resetKeys}
      fallbackRender={({ resetErrorBoundary }) => (
        <EmptyState
          icon={IconAlertTriangle}
          title={t("Failed to load boards. An error occurred.")}
          action={
            <Button
              variant="default"
              size="sm"
              mt="xs"
              onClick={resetErrorBoundary}
            >
              {t("Try again")}
            </Button>
          }
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
