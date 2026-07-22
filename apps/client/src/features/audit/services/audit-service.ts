import api from "@/lib/api-client";
import { IPagination } from "@/lib/types";
import {
  IAuditLog,
  IAuditLogParams,
  IAuditRetention,
  IAuditVerifyResult,
} from "../types/audit.types";

export async function getAuditLogs(
  params?: IAuditLogParams,
): Promise<IPagination<IAuditLog>> {
  const req = await api.post("/audit", { ...params });
  return req.data;
}

export async function getAuditRetention(): Promise<IAuditRetention> {
  const req = await api.post("/audit/retention");
  return req.data;
}

export async function updateAuditRetention(data: {
  auditRetentionDays: number;
}): Promise<IAuditRetention> {
  const req = await api.post("/audit/retention/update", data);
  return req.data;
}

export async function verifyAuditIntegrity(): Promise<IAuditVerifyResult> {
  const req = await api.post("/audit/verify", {});
  return req.data;
}

export async function exportAuditLogs(
  params: IAuditLogParams,
  format: "csv" | "json",
): Promise<void> {
  const res = await api.post(
    "/audit/export",
    { ...params, format },
    { responseType: "blob" },
  );

  const blob = new Blob([res.data], {
    type: format === "csv" ? "text/csv" : "application/json",
  });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  link.download = `audit-${stamp}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
