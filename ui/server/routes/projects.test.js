import fs from 'node:fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { resolvePilotHome } from '../utils/pilotPaths.js';
import { createCloneSession, takeCloneSession, validateWorkspacePath } from './projects.js';

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
