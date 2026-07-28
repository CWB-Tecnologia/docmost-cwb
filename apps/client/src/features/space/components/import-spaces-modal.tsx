import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  FileButton,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconFileTypeZip, IconTrash } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { importSpaceZip } from "@/features/space/services/space-service.ts";
import { spaceNameFromZipFileName } from "@/features/space/utils/space-import.ts";
import { getFileTaskById } from "@/features/file-task/services/file-task-service.ts";
import { computeSpaceSlug, formatBytes } from "@/lib";
import { getFileImportSizeLimit } from "@/lib/config.ts";
import { queryClient } from "@/main.tsx";

type ImportRowStatus =
  | "pending"
  | "uploading"
  | "importing"
  | "success"
  | "failed";

interface ImportRow {
  id: string;
  file: File;
  name: string;
  slug: string;
  status: ImportRowStatus;
  message?: string;
  fileTaskId?: string;
}

export default function ImportSpacesModal() {
  const { t } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);

  return (
    <>
      <Button variant="default" onClick={open}>
        {t("Import spaces")}
      </Button>

      <Modal
        opened={opened}
        onClose={close}
        title={t("Import spaces")}
        size={760}
        closeButtonProps={{ "aria-label": t("Close") }}
      >
        <Divider size="xs" mb="xs" />
        <ImportSpacesForm />
      </Modal>
    </>
  );
}

function ImportSpacesForm() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const resetFileRef = useRef<() => void>(null);

  // The polling interval reads the rows through a ref so that adding a row
  // mid-flight does not restart it with a stale snapshot.
  const rowsRef = useRef<ImportRow[]>(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const updateRow = (id: string, patch: Partial<ImportRow>) => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  const isImporting = rows.some((row) => row.status === "importing");

  useEffect(() => {
    if (!isImporting) return;

    const intervalId = setInterval(async () => {
      const inflight = rowsRef.current.filter(
        (row) => row.status === "importing" && row.fileTaskId,
      );

      for (const row of inflight) {
        try {
          const fileTask = await getFileTaskById(row.fileTaskId);

          if (fileTask.status === "success") {
            updateRow(row.id, { status: "success", message: undefined });
            queryClient.invalidateQueries({ queryKey: ["spaces"] });
          }

          if (fileTask.status === "failed") {
            updateRow(row.id, {
              status: "failed",
              message:
                fileTask.errorMessage ?? t("Something went wrong during import"),
            });
          }
        } catch (err) {
          updateRow(row.id, {
            status: "failed",
            message:
              err?.response?.data?.message ?? t("Failed to fetch import status"),
          });
        }
      }
    }, 3000);

    return () => clearInterval(intervalId);
  }, [isImporting]);

  const handleFileSelect = (selectedFiles: File[]) => {
    if (!selectedFiles?.length) return;

    const maxSize = getFileImportSizeLimit();
    const oversized = selectedFiles.filter((file) => file.size > maxSize);
    if (oversized.length > 0) {
      notifications.show({
        color: "red",
        message: t("File exceeds the {{limit}} import limit", {
          limit: formatBytes(maxSize),
        }),
      });
    }

    const newRows: ImportRow[] = selectedFiles
      .filter((file) => file.size <= maxSize)
      .map((file, index) => {
        const name = spaceNameFromZipFileName(file.name);
        return {
          id: `${file.name}-${file.size}-${index}-${rows.length}`,
          file,
          name,
          slug: computeSpaceSlug(name),
          status: "pending" as ImportRowStatus,
        };
      });

    setRows((current) => [...current, ...newRows]);
    resetFileRef.current?.();
  };

  const handleImport = async () => {
    const queued = rows.filter(
      (row) => row.status === "pending" || row.status === "failed",
    );
    if (queued.length === 0) return;

    setUploading(true);

    // Sequential on purpose: slugs are validated against what already exists, so
    // two uploads racing on the same slug would report a confusing failure.
    for (const row of queued) {
      updateRow(row.id, { status: "uploading", message: undefined });

      try {
        const { fileTask } = await importSpaceZip({
          file: row.file,
          name: row.name.trim(),
          slug: row.slug.trim(),
          source: "generic",
        });

        updateRow(row.id, { status: "importing", fileTaskId: fileTask.id });
      } catch (err) {
        updateRow(row.id, {
          status: "failed",
          message: err?.response?.data?.message ?? t("Failed to upload file"),
        });
      }
    }

    setUploading(false);
    queryClient.invalidateQueries({ queryKey: ["spaces"] });
  };

  const statusBadge = (row: ImportRow) => {
    switch (row.status) {
      case "uploading":
        return (
          <Badge variant="light" leftSection={<Loader size={10} />}>
            {t("Uploading")}
          </Badge>
        );
      case "importing":
        return (
          <Badge variant="light" leftSection={<Loader size={10} />}>
            {t("Importing")}
          </Badge>
        );
      case "success":
        return (
          <Badge color="teal" variant="light">
            {t("Imported")}
          </Badge>
        );
      case "failed":
        return (
          <Tooltip label={row.message} multiline w={280} withArrow>
            <Badge color="red" variant="light">
              {t("Failed")}
            </Badge>
          </Tooltip>
        );
      default:
        return (
          <Badge color="gray" variant="light">
            {t("Ready")}
          </Badge>
        );
    }
  };

  const isRowLocked = (row: ImportRow) =>
    row.status === "uploading" ||
    row.status === "importing" ||
    row.status === "success";

  const queuedCount = rows.filter(
    (row) => row.status === "pending" || row.status === "failed",
  ).length;

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t(
          "Each zip becomes a new space. Upload space exports (zip with Markdown or HTML files). Max: {{sizeLimit}} per file.",
          { sizeLimit: formatBytes(getFileImportSizeLimit()) },
        )}
      </Text>

      <Group>
        <FileButton
          onChange={handleFileSelect}
          accept="application/zip"
          multiple
          resetRef={resetFileRef}
          inputProps={{
            "aria-label": t("Choose {{format}} file", { format: "ZIP" }),
          }}
        >
          {(props) => (
            <Button
              variant="default"
              leftSection={<IconFileTypeZip size={18} />}
              {...props}
            >
              {t("Select zip files")}
            </Button>
          )}
        </FileButton>
      </Group>

      {rows.length > 0 && (
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w="26%">{t("File")}</Table.Th>
                <Table.Th w="26%">{t("Space name")}</Table.Th>
                <Table.Th w="20%">{t("Space slug")}</Table.Th>
                <Table.Th w="18%">{t("Status")}</Table.Th>
                <Table.Th w="10%" />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td>
                    <Text size="sm" truncate="end" title={row.file.name}>
                      {row.file.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {formatBytes(row.file.size)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      size="xs"
                      variant="filled"
                      value={row.name}
                      disabled={isRowLocked(row)}
                      aria-label={t("Space name")}
                      onChange={(event) =>
                        updateRow(row.id, {
                          name: event.currentTarget.value,
                          slug: computeSpaceSlug(event.currentTarget.value),
                        })
                      }
                    />
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      size="xs"
                      variant="filled"
                      value={row.slug}
                      disabled={isRowLocked(row)}
                      aria-label={t("Space slug")}
                      onChange={(event) =>
                        updateRow(row.id, { slug: event.currentTarget.value })
                      }
                    />
                  </Table.Td>
                  <Table.Td>{statusBadge(row)}</Table.Td>
                  <Table.Td>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      disabled={
                        row.status === "uploading" || row.status === "importing"
                      }
                      aria-label={t("Remove")}
                      onClick={() =>
                        setRows((current) =>
                          current.filter((item) => item.id !== row.id),
                        )
                      }
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {rows.some((row) => row.status === "failed") && (
        <Text size="xs" c="red">
          {t(
            "A failed row keeps its fields editable. Fix the name or slug and import again.",
          )}
        </Text>
      )}

      {isImporting && (
        <Text size="xs" c="dimmed">
          {t(
            "The import runs on the server. Closing this tab only stops the progress updates.",
          )}
        </Text>
      )}

      <Group justify="flex-end">
        <Button
          onClick={handleImport}
          loading={uploading}
          disabled={queuedCount === 0}
        >
          {t("Import")}
        </Button>
      </Group>
    </Stack>
  );
}
