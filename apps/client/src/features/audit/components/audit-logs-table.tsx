import { Fragment, useState } from "react";
import {
  Table,
  Text,
  Group,
  Skeleton,
  Collapse,
  Box,
  Code,
} from "@mantine/core";
import { useTranslation } from "react-i18next";
import { IconChevronRight, IconChevronDown } from "@tabler/icons-react";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import NoTableResults from "@/components/common/no-table-results";
import { formattedDate } from "@/lib/time";
import { IAuditLog } from "../types/audit.types";
import { getEventLabel } from "../lib/audit-event-labels";
import classes from "./audit-logs.module.css";

type AuditLogsTableProps = {
  items?: IAuditLog[];
  isLoading: boolean;
};

function hasDetails(entry: IAuditLog): boolean {
  return Boolean(entry.hash);
}

function TableSkeleton() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <Table.Tr key={i}>
          <Table.Td>
            <Group gap="sm" wrap="nowrap">
              <Skeleton circle height={32} />
              <div>
                <Skeleton height={12} width={120} mb={4} />
                <Skeleton height={9} width={150} />
              </div>
            </Group>
          </Table.Td>
          <Table.Td>
            <Skeleton height={12} width={130} />
          </Table.Td>
          <Table.Td>
            <Skeleton height={12} width={90} />
          </Table.Td>
          <Table.Td>
            <Skeleton height={12} width={140} />
          </Table.Td>
        </Table.Tr>
      ))}
    </>
  );
}

export default function AuditLogsTable({
  items,
  isLoading,
}: AuditLogsTableProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <Table.ScrollContainer minWidth={700}>
      <Table highlightOnHover verticalSpacing="xs" className={classes.table}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("Actor")}</Table.Th>
            <Table.Th>{t("Event")}</Table.Th>
            <Table.Th>{t("IP address")}</Table.Th>
            <Table.Th>{t("Date")}</Table.Th>
          </Table.Tr>
        </Table.Thead>

        <Table.Tbody>
          {isLoading ? (
            <TableSkeleton />
          ) : items && items.length > 0 ? (
            items.map((entry) => {
              const expandable = hasDetails(entry);
              const isExpanded = expanded.has(entry.id);

              return (
                <Fragment key={entry.id}>
                  <Table.Tr
                    onClick={expandable ? () => toggle(entry.id) : undefined}
                    style={{ cursor: expandable ? "pointer" : undefined }}
                  >
                    <Table.Td>
                      <Group gap="sm" wrap="nowrap">
                        {expandable ? (
                          isExpanded ? (
                            <IconChevronDown
                              size={16}
                              color="var(--mantine-color-dimmed)"
                            />
                          ) : (
                            <IconChevronRight
                              size={16}
                              color="var(--mantine-color-dimmed)"
                            />
                          )
                        ) : (
                          <Box w={16} />
                        )}
                        {entry.actor ? (
                          <Group gap="sm" wrap="nowrap">
                            <CustomAvatar
                              avatarUrl={entry.actor.avatarUrl ?? undefined}
                              name={entry.actor.name ?? entry.actor.email}
                              size={32}
                            />
                            <div>
                              <Text fz="sm" fw={500} lineClamp={1}>
                                {entry.actor.name ?? entry.actor.email}
                              </Text>
                              <Text fz="xs" c="dimmed">
                                {entry.actor.email}
                              </Text>
                            </div>
                          </Group>
                        ) : (
                          <Text fz="sm" c="dimmed" fs="italic">
                            {t("System")}
                          </Text>
                        )}
                      </Group>
                    </Table.Td>

                    <Table.Td>
                      <Text fz="sm">{t(getEventLabel(entry.event))}</Text>
                    </Table.Td>

                    <Table.Td>
                      <Text fz="sm" c="dimmed">
                        {entry.ipAddress ?? "—"}
                      </Text>
                    </Table.Td>

                    <Table.Td>
                      <Text fz="sm" style={{ whiteSpace: "nowrap" }}>
                        {formattedDate(new Date(entry.createdAt))}
                      </Text>
                    </Table.Td>
                  </Table.Tr>

                  {expandable && (
                    <Table.Tr className={classes.detailRow}>
                      <Table.Td colSpan={4} p={0}>
                        <Collapse expanded={isExpanded}>
                          <Box
                            px="md"
                            py="sm"
                            className={classes.detailContent}
                          >
                            <Group gap="lg" mb="xs" align="flex-start">
                              <Box>
                                <Text fz="xs" fw={600}>
                                  {t("Sequence")}
                                </Text>
                                <Text fz="xs">#{entry.seq}</Text>
                              </Box>
                              <Box>
                                <Text fz="xs" fw={600}>
                                  {t("Resource")}
                                </Text>
                                <Text fz="xs">
                                  {entry.resourceType}
                                  {entry.resourceId
                                    ? ` · ${entry.resourceId}`
                                    : ""}
                                </Text>
                              </Box>
                              {entry.userAgent && (
                                <Box style={{ minWidth: 0 }}>
                                  <Text fz="xs" fw={600}>
                                    {t("User agent")}
                                  </Text>
                                  <Text fz="xs" lineClamp={2}>
                                    {entry.userAgent}
                                  </Text>
                                </Box>
                              )}
                            </Group>
                            <Box mb="xs">
                              <Text fz="xs" fw={600} mb={4}>
                                {t("Integrity hashes")}
                              </Text>
                              <Code block className={classes.mono}>
                                {`prev: ${entry.prevHash || "(genesis)"}\nhash: ${entry.hash}`}
                              </Code>
                            </Box>
                            {entry.changes && (
                              <Box mb="xs">
                                <Text fz="xs" fw={600} mb={4}>
                                  {t("Changes")}
                                </Text>
                                <Code block className={classes.mono}>
                                  {JSON.stringify(entry.changes, null, 2)}
                                </Code>
                              </Box>
                            )}
                            {entry.metadata &&
                              Object.keys(entry.metadata).length > 0 && (
                                <Box>
                                  <Text fz="xs" fw={600} mb={4}>
                                    {t("Metadata")}
                                  </Text>
                                  <Code block className={classes.mono}>
                                    {JSON.stringify(entry.metadata, null, 2)}
                                  </Code>
                                </Box>
                              )}
                          </Box>
                        </Collapse>
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Fragment>
              );
            })
          ) : (
            <NoTableResults colSpan={4} />
          )}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
