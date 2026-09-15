import { useCallback, useEffect, useRef, useState } from "react";
import { getCloudSyncStatus, type CloudSyncProgress, type CloudSyncStatus } from "./storage";

export function useCloudSyncStatus(endpoint: string, activity?: CloudSyncProgress) {
  const syncEndpoint = endpoint.trim().replace(/\/+$/, "");
  const activeEndpoint = useRef(syncEndpoint);
  activeEndpoint.current = syncEndpoint;
  const requestVersion = useRef(0);
  const [loaded, setLoaded] = useState<{ endpoint: string; status?: CloudSyncStatus }>();

  const refreshSyncStatus = useCallback(async () => {
    const version = ++requestVersion.current;
    let status: CloudSyncStatus | undefined;
    try {
      status = await getCloudSyncStatus(syncEndpoint);
    } catch {
      // An incomplete address or unreadable credential must never retain the
      // previous server's authenticated UI state.
      status = undefined;
    }
    if (version === requestVersion.current && activeEndpoint.current === syncEndpoint) {
      setLoaded({ endpoint: syncEndpoint, status });
    }
  }, [syncEndpoint]);

  useEffect(() => {
    void refreshSyncStatus();
    return () => { requestVersion.current += 1; };
  }, [refreshSyncStatus, activity?.operationId, activity?.status]);

  return {
    syncStatus: loaded?.endpoint === syncEndpoint ? loaded.status : undefined,
    refreshSyncStatus,
  };
}
