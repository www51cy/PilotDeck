import { describe, expect, it } from 'vitest';
import { formatGitStatusChip } from './useGitStatusSummary';

describe('formatGitStatusChip', () => {
  it('shows the branch and the number of uncommitted files', () => {
    expect(formatGitStatusChip({
      isRepository: true, branch: 'main', dirty: 29, ahead: 0, behind: 0,
    })).toBe('⎇ main (+29)');
  });

  it('shows only the branch when the working tree is clean', () => {
    expect(formatGitStatusChip({
      isRepository: true, branch: 'feature/x', dirty: 0, ahead: 3, behind: 0,
    })).toBe('⎇ feature/x');
  });

  it('renders nothing for a non-repository project', () => {
    expect(formatGitStatusChip(null)).toBeNull();
    expect(formatGitStatusChip(undefined)).toBeNull();
  });

  it('renders nothing when the branch is unknown', () => {
    expect(formatGitStatusChip({
      isRepository: true, branch: '', dirty: 2, ahead: 0, behind: 0,
    })).toBeNull();
  });
});
