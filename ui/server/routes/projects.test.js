import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { validateWorkspacePath } from './projects.js';

describe('validateWorkspacePath', () => {
  it('rejects the filesystem root and system directories', async () => {
    for (const target of ['/', '/etc', '/etc/pilotdeck', '/usr', '/usr/local/pilotdeck']) {
      const result = await validateWorkspacePath(target);
      expect(result.valid, target).toBe(false);
    }
  });

  it('rejects the root home directory itself', async () => {
    const result = await validateWorkspacePath('/root');
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
});
