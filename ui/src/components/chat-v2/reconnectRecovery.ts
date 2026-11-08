import { buildSessionStatusRequestIfIdle } from '../chat/sessionStatusProtocol';

export function shouldRefreshSessionOnReconnect({
  sessionId,
}: {
  isLoading: boolean;
  processingSessions?: Set<string>;
  sessionId: string;
}): boolean {
  // Reconnect must re-align persisted history even while realtime replay resumes.
  // The store reconciliation retains unpersisted streaming rows during refresh.
  return Boolean(sessionId);
}

export function buildReconnectStatusMessage(sessionId: string, expectedActiveRunId: string | null) {
  return buildSessionStatusRequestIfIdle({
    sessionId,
    provider: 'pilotdeck',
    expectedActiveRunId,
    includeActiveTurnMessages: true,
  });
}

export async function refreshSessionAfterReconnect(refresh: () => Promise<unknown>): Promise<void> {
  try {
    await refresh();
  } catch (error) {
    console.error('Error refreshing session after WebSocket reconnect:', error);
  }
}
