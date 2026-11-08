import fs from 'node:fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { resolvePilotHome } from '../utils/pilotPaths.js';
import { createCloneSession, parseGitHubRepository, takeCloneSession, validateWorkspacePath } from './projects.js';

describe('validateWorkspacePath', () => {
  it('rejects the filesystem root and system directories', async () => {
    for (const target of ['/', '/etc', '/etc/pilotdeck', '/usr', '/usr/local/pilotdeck']) {
      const result = await validateWorkspacePath(target);
      expect(result.valid, target).toBe(false);
    }
  });

  it('rejects the user home directory itself', async () => {
    const result = await validateWorkspacePath(os.homedir());
    expect(result.valid).toBe(false);
    expect(result.error).toContain('system-critical');
  });

  it('allows workspaces under the user home directory (folder browser default)', async () => {
    const target = path.join(os.homedir(), 'pilotdeck-workspace');
    const result = await validateWorkspacePath(target);
    expect(result.valid, JSON.stringify(result)).toBe(true);
  });

  it('allows temporary locations and the /var/tmp exception', async () => {
    for (const target of ['/tmp/pilotdeck-workspace', '/var/tmp/pilotdeck-workspace']) {
      const result = await validateWorkspacePath(target);
      expect(result.valid, target).toBe(true);
    }
  });

  it('rejects PilotDeck internal storage as a real workspace', async () => {
    const result = await validateWorkspacePath(resolvePilotHome(process.env));
    expect(result.valid).toBe(false);
  });

  it('checks the real target through missing intermediate directories', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-workspace-validation-'));
    try {
      const link = path.join(base, 'system-link');
      await fs.symlink('/etc', link, 'dir');
      for (const target of [path.join(link, 'direct'), path.join(link, 'missing', 'nested')]) {
        const result = await validateWorkspacePath(target);
        expect(result.valid, target).toBe(false);
      }
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

describe('clone sessions', () => {
  it('returns the stored payload exactly once', () => {
    const id = createCloneSession({ workspacePath: '/tmp/work', githubUrl: 'https://github.com/u/r', githubToken: 'secret' });
    expect(takeCloneSession(id)).toMatchObject({ workspacePath: '/tmp/work', githubToken: 'secret' });
    expect(takeCloneSession(id)).toBeNull();
  });

  it('rejects unknown ids and expired sessions', () => {
    expect(takeCloneSession('does-not-exist')).toBeNull();
    const id = createCloneSession({ workspacePath: '/tmp/work' }, -1);
    expect(takeCloneSession(id)).toBeNull();
  });

  it('allows only the creating user to consume a session', () => {
    const id = createCloneSession({ workspacePath: '/tmp/work', userId: 1 });
    expect(takeCloneSession(id, 2)).toBeNull();
    expect(takeCloneSession(id, 1)).toMatchObject({ workspacePath: '/tmp/work', userId: 1 });
    expect(takeCloneSession(id, 1)).toBeNull();
  });
});


describe('validateWorkspacePath symbolic link boundaries', () => {
  it('rejects dangling, chained and looping symbolic links but allows ordinary missing paths', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-dangling-link-'));
    try {
      const dangling = path.join(base, 'dangling');
      const chained = path.join(base, 'chained');
      const loopA = path.join(base, 'loop-a');
      const loopB = path.join(base, 'loop-b');
      await fs.symlink('/etc/pilotdeck-target-that-does-not-exist', dangling, 'dir');
      await fs.symlink(dangling, chained, 'dir');
      await fs.symlink(loopB, loopA, 'dir');
      await fs.symlink(loopA, loopB, 'dir');

      expect((await validateWorkspacePath(path.join(dangling, 'nested'))).valid).toBe(false);
      expect((await validateWorkspacePath(path.join(chained, 'nested'))).valid).toBe(false);
      expect((await validateWorkspacePath(path.join(loopA, 'nested'))).valid).toBe(false);
      expect((await validateWorkspacePath(path.join(base, 'ordinary', 'missing'))).valid).toBe(true);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

describe('clone session expiration timer', () => {
  it('removes sessions when their expiration timer fires', () => {
    vi.useFakeTimers();
    try {
      const id = createCloneSession({ workspacePath: '/tmp/work', userId: 1 }, 10);
      vi.advanceTimersByTime(11);
      expect(takeCloneSession(id, 1)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('parseGitHubRepository', () => {
  it('accepts canonical HTTPS and SSH GitHub repository URLs', () => {
    expect(parseGitHubRepository('https://github.com/openbmb/PilotDeck.git')).toMatchObject({
      repoName: 'PilotDeck',
      protocol: 'https:',
      origin: 'https://github.com',
    });
    expect(parseGitHubRepository('git@github.com:openbmb/PilotDeck.git')).toMatchObject({
      repoName: 'PilotDeck',
      protocol: 'ssh:',
    });
  });

  it('rejects credential-bearing, non-GitHub and path-traversal URLs', () => {
    const invalidUrls = [
      'https://token@github.com/openbmb/PilotDeck.git',
      'https://evil.example/openbmb/PilotDeck.git',
      'https://github.com/openbmb/..',
      'https://github.com/openbmb/%2E%2E',
      'https://github.com/openbmb/%2Fetc',
      'https://github.com/openbmb/PilotDeck.git?target=elsewhere',
    ];
    for (const url of invalidUrls) {
      expect(() => parseGitHubRepository(url), url).toThrow();
    }
  });
});
