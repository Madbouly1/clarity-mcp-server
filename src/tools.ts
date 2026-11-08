import {
  ANALYTICS_DASHBOARD_URL,
  DOCUMENTATION_URL,
  SESSION_RECORDINGS_URL
} from "./constants.js";
import {
  type FiltersType,
  type SortOptionsType,
  SortOptionsEnum
} from "./types.js";
import { postClarityAsync } from "./utils.js";

// Authentication headers are added centrally by postClarityAsync based on CLARITY_AUTH_MODE.

export async function queryAnalyticsDashboardAsync(
  query: string,
  timezone: string,
): Promise<any> {
  return await postClarityAsync(ANALYTICS_DASHBOARD_URL, {
    query: query,
    timezone: timezone,
  });
}

export async function queryDocumentationAsync(query: string): Promise<any> {
  return await postClarityAsync(DOCUMENTATION_URL, {
    query: query,
  });
}

export async function listSessionRecordingsAsync(
  startDate: Date,
  endDate: Date,
  filters: FiltersType,
  sortBy: SortOptionsType,
  count: number
): Promise<any> {
  return await postClarityAsync(SESSION_RECORDINGS_URL, {
    sortBy: SortOptionsEnum[sortBy],
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    filters: filters,
    count: count
  });
}
