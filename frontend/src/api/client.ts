/**
 * Typed fetch wrappers for the FinOps Command Center backend.
 * In dev, requests are proxied to http://localhost:8000 by Vite.
 * In production, the SPA is served by FastAPI on the same origin.
 */
import type {
  AdminConfig,
  AdoptionReport,
  AppsCost,
  CacheStatusEntry,
  AdminWorkspacesResponse,
  AppConfig,
  Attribution,
  CostDrivers,
  DqmMonitor,
  DqmSummary,
  DqmWorkspaceCost,
  Envelope,
  GenieCost,
  AiCost,
  Grant,
  GovernanceReport,
  HubRec,
  HubSummary,
  Overview,
  QueryRow,
  TableHealth,
  TableProbe,
  TableRow,
  TablesSummary,
  TagsReport,
  TagSearchResult,
  Workspace,
  WorkspaceDetail,
} from "../types";

const API_BASE = "/api";

async function getEnvelope<T, S = unknown>(path: string): Promise<Envelope<T, S>> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Envelope<T, S>;
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "" && v !== "all")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch(`${API_BASE}/config`);
  return (await res.json()) as AppConfig;
}

// --- Admin: workspace scope + read-only risk-flag documentation -------------

export async function fetchAdminConfig(): Promise<AdminConfig> {
  const res = await fetch(`${API_BASE}/admin/config`);
  if (!res.ok) throw new Error(`API /admin/config failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as AdminConfig;
}

export async function fetchAdminWorkspaces(): Promise<AdminWorkspacesResponse> {
  const res = await fetch(`${API_BASE}/admin/workspaces`);
  if (!res.ok) throw new Error(`API /admin/workspaces failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as AdminWorkspacesResponse;
}

export async function refreshAdminWorkspaces(): Promise<AdminWorkspacesResponse> {
  const res = await fetch(`${API_BASE}/admin/workspaces/refresh`, { method: "POST" });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as AdminWorkspacesResponse;
}

export async function saveAdminWorkspaces(included: string[]): Promise<AdminWorkspacesResponse> {
  const res = await fetch(`${API_BASE}/admin/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ included }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Saving failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as AdminWorkspacesResponse;
}

export function fetchOverview(): Promise<Envelope<Overview>> {
  return getEnvelope<Overview>("/overview");
}

export function fetchCostDrivers(
  params: { workspace?: string } = {},
): Promise<Envelope<CostDrivers>> {
  return getEnvelope<CostDrivers>(`/cost-drivers${qs(params)}`);
}

export function fetchWorkspaces(
  params: Record<string, string> = {},
): Promise<Envelope<Workspace[]>> {
  return getEnvelope<Workspace[]>(`/workspaces${qs(params)}`);
}

export function fetchWorkspaceDetail(
  workspaceId: string,
): Promise<Envelope<WorkspaceDetail>> {
  return getEnvelope<WorkspaceDetail>(`/workspaces/${encodeURIComponent(workspaceId)}`);
}

export function fetchQueries(
  params: Record<string, string | number> = {},
): Promise<Envelope<QueryRow[]>> {
  return getEnvelope<QueryRow[]>(`/queries${qs(params)}`);
}

// On-demand ai_query review of one statement fingerprint (runs as the viewer).
export async function postQueryAnalyse(
  fingerprint: string,
): Promise<Envelope<{ fingerprint: string; ai_advice: string; ai_model: string }>> {
  const res = await fetch(`${API_BASE}/queries/analyse?fingerprint=${encodeURIComponent(fingerprint)}`, {
    method: "POST",
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`AI review failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as Envelope<{ fingerprint: string; ai_advice: string; ai_model: string }>;
}

export function fetchTables(
  params: Record<string, string> = {},
): Promise<Envelope<TableRow[], TablesSummary>> {
  return getEnvelope<TableRow[], TablesSummary>(`/tables${qs(params)}`);
}

export function fetchTablesHealth(): Promise<Envelope<TableHealth>> {
  return getEnvelope<TableHealth>("/tables/health");
}

export function fetchTableProbe(fqn: string): Promise<Envelope<TableProbe>> {
  return getEnvelope<TableProbe>(`/tables/probe?fqn=${encodeURIComponent(fqn)}`);
}

export function fetchGrants(): Promise<Envelope<Grant[]>> {
  return getEnvelope<Grant[]>("/access/grants");
}

export function fetchAdoption(): Promise<Envelope<AdoptionReport>> {
  return getEnvelope<AdoptionReport>("/adoption");
}

export function fetchAppsCost(): Promise<Envelope<AppsCost>> {
  return getEnvelope<AppsCost>("/apps-cost");
}

// Name an OAuth app integration for the Apps $ OBO attribution card.
export async function saveAppIdentityLabel(integrationId: string, name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/apps/identity-label`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ integration_id: integrationId, name }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Saving label failed: ${res.status} ${detail.slice(0, 200)}`);
  }
}

export async function fetchCacheStatus(): Promise<{ data: CacheStatusEntry[]; ttl_seconds: number }> {
  const res = await fetch(`${API_BASE}/admin/cache`);
  if (!res.ok) throw new Error(`API /admin/cache failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as { data: CacheStatusEntry[]; ttl_seconds: number };
}

export async function postCacheRefresh(objectId: string): Promise<{ data: CacheStatusEntry[]; ttl_seconds: number }> {
  const res = await fetch(`${API_BASE}/admin/cache/${encodeURIComponent(objectId)}/refresh`, { method: "POST" });
  if (!res.ok) throw new Error(`Cache refresh failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as { data: CacheStatusEntry[]; ttl_seconds: number };
}

export function fetchGovernance(
  params: Record<string, string> = {},
): Promise<Envelope<GovernanceReport>> {
  return getEnvelope<GovernanceReport>(`/governance${qs(params)}`);
}

// --- Tags: coverage + catalog (cached) and per-tag search (live) -----------

export function fetchTags(): Promise<Envelope<TagsReport>> {
  return getEnvelope<TagsReport>("/tags");
}

export function fetchTagSearch(key: string, value?: string): Promise<Envelope<TagSearchResult>> {
  const v = value ? `&value=${encodeURIComponent(value)}` : "";
  return getEnvelope<TagSearchResult>(`/tags/search?key=${encodeURIComponent(key)}${v}`);
}

// Operator-excluded blanket tag keys — saving clears every cached object so
// tagging metrics recompute consistently across tabs.
export async function saveTagExclusions(keys: string[]): Promise<{ keys: string[] }> {
  const res = await fetch(`${API_BASE}/tags/exclusions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Saving exclusions failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as { keys: string[] };
}


// The hub envelope carries the rec list in `data`, plus a `summary` (KPIs) and
// an `attribution` rollup alongside it.
export interface HubEnvelope extends Envelope<HubRec[], HubSummary> {
  attribution: Attribution;
}

export function fetchRecommendationsHub(
  params: Record<string, string> = {},
): Promise<HubEnvelope> {
  return getEnvelope<HubRec[], HubSummary>(`/recommendations/hub${qs(params)}`) as Promise<HubEnvelope>;
}

// --- Genie cost attribution --------------------------

export function fetchGenieCost(
  params: { workspace?: string } = {},
): Promise<Envelope<GenieCost>> {
  return getEnvelope<GenieCost>(`/genie-cost${qs(params)}`);
}

// --- AI cost attribution (all AI billing products; always on) --------------

export function fetchAiCost(
  params: { workspace?: string } = {},
): Promise<Envelope<AiCost>> {
  return getEnvelope<AiCost>(`/ai-cost${qs(params)}`);
}

// --- Data Quality Monitoring -------------

export interface DqmEnvelope extends Envelope<DqmMonitor[], DqmSummary> {
  by_workspace: DqmWorkspaceCost[];
  caveat: string;
}

export function fetchDqm(
  params: Record<string, string> = {},
): Promise<DqmEnvelope> {
  return getEnvelope<DqmMonitor[], DqmSummary>(`/dqm${qs(params)}`) as Promise<DqmEnvelope>;
}

// --- Ask Genie SSE ---------------------

export async function postGenieAsk(question: string): Promise<Response> {
  return fetch(`${API_BASE}/genie/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
}
