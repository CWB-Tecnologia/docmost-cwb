import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Menu,
  NumberInput,
  Popover,
  Select,
  Space,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import {
  IconSettings,
  IconDownload,
  IconShieldCheck,
} from "@tabler/icons-react";
import SettingsTitle from "@/components/settings/settings-title";
import { getAppName } from "@/lib/config";
import Paginate from "@/components/common/paginate";
import { useCursorPaginate } from "@/hooks/use-cursor-paginate";
import useUserRole from "@/hooks/use-user-role";
import { notifications } from "@mantine/notifications";
import {
  useAuditLogsQuery,
  useAuditRetentionQuery,
  useUpdateAuditRetentionMutation,
  useVerifyAuditMutation,
} from "../queries/audit-query";
import { IAuditLogParams } from "../types/audit.types";
import { eventFilterOptions } from "../lib/audit-event-labels";
import { exportAuditLogs } from "../services/audit-service";
import AuditLogsTable from "../components/audit-logs-table";
import { useWorkspaceMembersQuery } from "@/features/workspace/queries/workspace-query";
import { getSpaces } from "@/features/space/services/space-service";
import { useQuery } from "@tanstack/react-query";

type RetentionUnit = "days" | "months" | "years";

const resourceTypeOptions = [
  "audit",
  "workspace",
  "user",
  "page",
  "space",
  "space_member",
  "group",
  "comment",
  "share",
  "api_key",
  "scim_token",
  "sso_provider",
  "workspace_invitation",
  "attachment",
  "license",
].map((value) => ({ value, label: value.replaceAll("_", " ") }));

function startOfDayIso(value: string | null): string | undefined {
  return value ? `${value}T00:00:00.000Z` : undefined;
}

function endOfDayIso(value: string | null): string | undefined {
  return value ? `${value}T23:59:59.999Z` : undefined;
}

function daysToRetention(days: number): {
  amount: number;
  unit: RetentionUnit;
} {
  if (days >= 365 && days % 365 === 0)
    return { amount: days / 365, unit: "years" };
  if (days >= 30 && days % 30 === 0)
    return { amount: days / 30, unit: "months" };
  return { amount: days, unit: "days" };
}

function retentionToDays(amount: number, unit: RetentionUnit): number {
  if (unit === "years") return amount * 365;
  if (unit === "months") return amount * 30;
  return amount;
}

export default function AuditLogs() {
  const { t } = useTranslation();
  const { isOwner } = useUserRole();
  const { cursor, goNext, goPrev, resetCursor } = useCursorPaginate();

  const [eventFilter, setEventFilter] = useState<string | null>(null);
  const [actorFilter, setActorFilter] = useState<string | null>(null);
  const [resourceFilter, setResourceFilter] = useState<string | null>(null);
  const [spaceFilter, setSpaceFilter] = useState<string | null>(null);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { data: membersData } = useWorkspaceMembersQuery({
    limit: 100,
    query: "",
  });
  const { data: spacesData } = useQuery({
    queryKey: ["spaces", { limit: 100 }],
    queryFn: () => getSpaces({ limit: 100 }),
  });

  const { data: retentionData } = useAuditRetentionQuery();
  const updateRetention = useUpdateAuditRetentionMutation();
  const verify = useVerifyAuditMutation();

  const currentDays = retentionData?.retentionDays ?? 365;
  const parsed = daysToRetention(currentDays);
  const [retentionAmount, setRetentionAmount] = useState<number | string>(
    parsed.amount,
  );
  const [retentionUnit, setRetentionUnit] = useState<RetentionUnit>(
    parsed.unit,
  );

  useEffect(() => {
    if (retentionData) {
      const { amount, unit } = daysToRetention(retentionData.retentionDays);
      setRetentionAmount(amount);
      setRetentionUnit(unit);
    }
  }, [retentionData?.retentionDays]);

  const resetRetentionForm = () => {
    const { amount, unit } = daysToRetention(currentDays);
    setRetentionAmount(amount);
    setRetentionUnit(unit);
  };

  const params: IAuditLogParams = useMemo(
    () => ({
      cursor,
      limit: 50,
      event: eventFilter ?? undefined,
      actorId: actorFilter ?? undefined,
      resourceType: resourceFilter ?? undefined,
      spaceId: spaceFilter ?? undefined,
      startDate: startOfDayIso(startDate),
      endDate: endOfDayIso(endDate),
    }),
    [
      cursor,
      eventFilter,
      actorFilter,
      resourceFilter,
      spaceFilter,
      startDate,
      endDate,
    ],
  );

  const { data, isLoading } = useAuditLogsQuery(params);

  if (!isOwner) return null;

  const handleEventChange = (value: string | null) => {
    setEventFilter(value);
    resetCursor();
  };

  const handleExport = async (format: "csv" | "json") => {
    try {
      await exportAuditLogs(
        {
          event: params.event,
          actorId: params.actorId,
          resourceType: params.resourceType,
          spaceId: params.spaceId,
          startDate: params.startDate,
          endDate: params.endDate,
        },
        format,
      );
    } catch {
      notifications.show({ message: t("Export failed"), color: "red" });
    }
  };

  return (
    <>
      <Helmet>
        <title>
          {t("Audit log")} - {getAppName()}
        </title>
      </Helmet>

      <SettingsTitle title={t("Audit log")} />

      <Group mb="md" gap="sm">
        <Select
          placeholder={t("Filter by event")}
          data={eventFilterOptions.map((group) => ({
            group: t(group.group),
            items: group.items.map((item) => ({
              value: item.value,
              label: t(item.label),
            })),
          }))}
          value={eventFilter}
          onChange={handleEventChange}
          clearable
          searchable
          w={220}
          size="sm"
        />

        <Select
          placeholder={t("Filter by actor")}
          data={(membersData?.items ?? []).map((member) => ({
            value: member.id,
            label: member.name || member.email,
          }))}
          value={actorFilter}
          onChange={(value) => {
            setActorFilter(value);
            resetCursor();
          }}
          clearable
          searchable
          w={200}
          size="sm"
        />

        <Select
          placeholder={t("Resource type")}
          data={resourceTypeOptions}
          value={resourceFilter}
          onChange={(value) => {
            setResourceFilter(value);
            resetCursor();
          }}
          clearable
          searchable
          w={170}
          size="sm"
        />

        <Select
          placeholder={t("Filter by space")}
          data={(spacesData?.items ?? []).map((space) => ({
            value: space.id,
            label: space.name,
          }))}
          value={spaceFilter}
          onChange={(value) => {
            setSpaceFilter(value);
            resetCursor();
          }}
          clearable
          searchable
          w={180}
          size="sm"
        />

        <TextInput
          type="date"
          value={startDate ?? ""}
          onChange={(event) => {
            setStartDate(event.currentTarget.value || null);
            resetCursor();
          }}
          aria-label={t("Start date")}
          size="sm"
          w={145}
        />

        <TextInput
          type="date"
          value={endDate ?? ""}
          onChange={(event) => {
            setEndDate(event.currentTarget.value || null);
            resetCursor();
          }}
          aria-label={t("End date")}
          size="sm"
          w={145}
        />

        <Tooltip label={t("Verify chain integrity")}>
          <ActionIcon
            variant="default"
            size="input-sm"
            ml="auto"
            loading={verify.isPending}
            onClick={() => verify.mutate()}
            aria-label={t("Verify chain integrity")}
          >
            <IconShieldCheck size={16} />
          </ActionIcon>
        </Tooltip>

        <Menu shadow="md" position="bottom-end" withArrow>
          <Menu.Target>
            <Tooltip label={t("Export")}>
              <ActionIcon
                variant="default"
                size="input-sm"
                aria-label={t("Export")}
              >
                <IconDownload size={16} />
              </ActionIcon>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => handleExport("csv")}>
              {t("Export as CSV")}
            </Menu.Item>
            <Menu.Item onClick={() => handleExport("json")}>
              {t("Export as JSON")}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>

        <Popover
          position="bottom-end"
          shadow="md"
          width={260}
          withArrow
          opened={settingsOpen}
          onChange={(opened) => {
            if (!opened) resetRetentionForm();
            setSettingsOpen(opened);
          }}
        >
          <Popover.Target>
            <Tooltip label={t("Audit settings")}>
              <ActionIcon
                variant="default"
                size="input-sm"
                onClick={() => setSettingsOpen((o) => !o)}
                aria-label={t("Audit settings")}
              >
                <IconSettings size={16} />
              </ActionIcon>
            </Tooltip>
          </Popover.Target>
          <Popover.Dropdown>
            <Text fz="sm" fw={500} mb={4}>
              {t("Retention")}
            </Text>
            <Text fz="xs" c="dimmed" mb="sm">
              {t(
                "Logs older than this period are automatically deleted (a sealed checkpoint keeps the chain verifiable). Set to 0 to keep forever.",
              )}
            </Text>
            <Group gap="xs" wrap="nowrap" mb="sm">
              <NumberInput
                value={retentionAmount}
                onChange={(value) =>
                  setRetentionAmount(
                    typeof value === "bigint" ? Number(value) : value,
                  )
                }
                min={0}
                hideControls
                size="sm"
                w={60}
              />
              <Select
                data={[
                  { value: "days", label: t("days") },
                  { value: "months", label: t("months") },
                  { value: "years", label: t("years") },
                ]}
                value={retentionUnit}
                onChange={(value) => {
                  if (
                    value === "days" ||
                    value === "months" ||
                    value === "years"
                  ) {
                    setRetentionUnit(value);
                  }
                }}
                size="sm"
                style={{ flex: 1 }}
                comboboxProps={{ withinPortal: false }}
              />
            </Group>
            <Group gap="xs" grow>
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  resetRetentionForm();
                  setSettingsOpen(false);
                }}
              >
                {t("Cancel")}
              </Button>
              <Button
                size="xs"
                loading={updateRetention.isPending}
                onClick={() => {
                  const num =
                    typeof retentionAmount === "number" ? retentionAmount : 0;
                  const clamped = Math.max(0, num);
                  setRetentionAmount(clamped);
                  const days = retentionToDays(clamped, retentionUnit);
                  if (days !== currentDays) {
                    updateRetention.mutate({ auditRetentionDays: days });
                  }
                  setSettingsOpen(false);
                }}
              >
                {t("Save")}
              </Button>
            </Group>
          </Popover.Dropdown>
        </Popover>
      </Group>

      <AuditLogsTable items={data?.items} isLoading={isLoading} />

      <Space h="md" />

      {data?.items && data.items.length > 0 && (
        <Paginate
          hasPrevPage={data?.meta?.hasPrevPage}
          hasNextPage={data?.meta?.hasNextPage}
          onNext={() => goNext(data?.meta?.nextCursor)}
          onPrev={goPrev}
        />
      )}
    </>
  );
}
