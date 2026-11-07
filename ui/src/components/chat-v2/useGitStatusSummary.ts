import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../utils/api';

export type GitStatusSummary = {
  isRepository: true;
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
};

/**
 * `⎇ main (+29)` — branch plus the number of uncommitted files. Returns null
 * when there is nothing meaningful to show (non-repo, unresolvable project).
 */
export function formatGitStatusChip(summary: GitStatusSummary | null | undefined): string | null {
  if (!summary?.isRepository || !summary.branch) return null;
  return summary.dirty > 0 ? `⎇ ${summary.branch} (+${summary.dirty})` : `⎇ ${summary.branch}`;
}

/**
 * Lightweight git summary for the composer chip. Cheaper than /api/git/status
 * (no per-file fingerprints, no `write-tree`), so it is safe to refresh when a
 * turn finishes and when the window regains focus.
 */
export function useGitStatusSummary(
  projectKey: string | undefined,
  refreshKey?: unknown,
): GitStatusSummary | null {
  const [summary, setSummary] = useState<GitStatusSummary | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!projectKey) {
      setSummary(null);
      return;
    }
    const requestId = ++requestIdRef.current;
    try {
      const response = await authenticatedFetch(
        `/api/git/status?project=${encodeURIComponent(projectKey)}&summary=1`,
      );
      if (!response.ok) throw new Error(`git status summary failed: ${response.status}`);
      const data = await response.json();
      if (requestId !== requestIdRef.current) return;
      if (!data?.isRepository || !data?.branch) {
        setSummary(null);
        return;
      }
      // Older servers ignore `summary=1` and answer with the full status
      // payload (per-file arrays). Fall back to `entries` so the chip still
      // shows a correct count without a runtime restart.
      const dirty = Number(data.dirty ?? data.entries?.length ?? 0) || 0;
      setSummary({
        isRepository: true,
        branch: String(data.branch),
        dirty,
        ahead: Number(data.ahead) || 0,
        behind: Number(data.behind) || 0,
      });
    } catch {
      if (requestId === requestIdRef.current) setSummary(null);
    }
  }, [projectKey]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  return summary;
}
