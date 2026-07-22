import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { IPagination } from "@/lib/types";
import {
  getAuditLogs,
  getAuditRetention,
  updateAuditRetention,
  verifyAuditIntegrity,
} from "../services/audit-service";
import {
  IAuditLog,
  IAuditLogParams,
  IAuditVerifyResult,
} from "../types/audit.types";

export function useAuditLogsQuery(
  params?: IAuditLogParams,
): UseQueryResult<IPagination<IAuditLog>, Error> {
  return useQuery({
    queryKey: ["audit-logs", params],
    queryFn: () => getAuditLogs(params),
    placeholderData: keepPreviousData,
  });
}

export function useAuditRetentionQuery() {
  return useQuery({
    queryKey: ["audit-retention"],
    queryFn: () => getAuditRetention(),
  });
}

export function useUpdateAuditRetentionMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: (data: { auditRetentionDays: number }) =>
      updateAuditRetention(data),
    onSuccess: () => {
      notifications.show({ message: t("Audit retention updated") });
      queryClient.invalidateQueries({ queryKey: ["audit-retention"] });
    },
    onError: (error: any) => {
      notifications.show({
        message: error?.response?.data?.message ?? t("Failed to update"),
        color: "red",
      });
    },
  });
}

export function useVerifyAuditMutation() {
  const { t } = useTranslation();

  return useMutation<IAuditVerifyResult, any, void>({
    mutationFn: () => verifyAuditIntegrity(),
    onSuccess: (res) => {
      if (res.ok) {
        notifications.show({
          message: t("Integrity verified: {{count}} entries intact", {
            count: res.checked,
          }),
          color: "green",
        });
      } else {
        notifications.show({
          title: t("Integrity check FAILED"),
          message: t("Tampering detected at entry #{{seq}} ({{reason}})", {
            seq: res.firstBrokenSeq ?? res.firstBrokenCheckpointSeq,
            reason: res.reason,
          }),
          color: "red",
          autoClose: false,
        });
      }
    },
    onError: () => {
      notifications.show({
        message: t("Integrity check could not be completed"),
        color: "red",
      });
    },
  });
}
