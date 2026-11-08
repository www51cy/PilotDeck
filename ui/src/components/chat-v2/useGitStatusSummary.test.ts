import { describe, expect, it } from 'vitest';
import { formatGitStatusChip, isOwnRepository } from './useGitStatusSummary';

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

describe('isOwnRepository', () => {
  it('accepts a workspace that is its own repository root', () => {
    expect(isOwnRepository('/root/pilotdeck', '/root/pilotdeck')).toBe(true);
    expect(isOwnRepository('/root/pilotdeck/', '/root/pilotdeck')).toBe(true);
  });

  it('rejects a workspace that merely sits inside another repository', () => {
    // A general workspace under an accidentally `git init`-ed home directory
    // must not borrow that repository's branch and dirty count.
    expect(isOwnRepository('/root/PilotDeckGeneral', '/root')).toBe(false);
    expect(isOwnRepository('/root/PilotDeckGeneral', '/root/')).toBe(false);
  });

  it('rejects when either side is unknown', () => {
    expect(isOwnRepository('/root/pilotdeck', undefined)).toBe(false);
    expect(isOwnRepository(undefined, '/root/pilotdeck')).toBe(false);
  });
});
