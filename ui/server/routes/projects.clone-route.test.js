import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addProjectManually: vi.fn(),
  getGithubTokenById: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../projects.js', () => ({
  addProjectManually: mocks.addProjectManually,
  extractProjectDirectory: vi.fn(),
}));
vi.mock('../discovery-plans.js', () => ({
  getProjectDiscoveryContext: vi.fn(),
  getProjectDiscoveryPlansOverview: vi.fn(),
  getProjectDiscoveryPlanReport: vi.fn(),
  rerunDiscoveryPlan: vi.fn(),
  getProjectWorkCycles: vi.fn(),
  applyWorkCycle: vi.fn(),
  archiveWorkCycle: vi.fn(),
}));
vi.mock('../database/db.js', () => ({ getGithubTokenById: mocks.getGithubTokenById }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: mocks.spawn, default: { ...(actual.default || actual), spawn: mocks.spawn } };
});

const REPOSITORY_URL = 'https://github.com/openbmb/PilotDeck.git';
let workspace;

beforeEach(async () => {
  vi.resetModules();
  mocks.addProjectManually.mockReset().mockImplementation(async (projectPath) => ({ path: projectPath }));
  mocks.getGithubTokenById.mockReset();
  mocks.spawn.mockReset();
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-clone-route-'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.doUnmock('fs');
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('clone route security and lifecycle', () => {
  it('rejects a non-GitHub host before issuing a session or resolving a token', async () => {
    const handler = await loadRouteHandler('post', '/clone-sessions');
    const res = createJsonResponse();

    await handler({
      body: { path: workspace, githubUrl: 'https://evil.example/openbmb/PilotDeck.git', githubTokenId: 42 },
      user: { id: 1 },
    }, res);

    expect(res.statusCode).toBe(400);
    expect(mocks.getGithubTokenById).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a workspace replaced by a dangling link before any write or spawn', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-mutated-workspace-'));
    const dangling = path.join(base, 'workspace-link');
    try {
      await fs.symlink('/etc/pilotdeck-mutated-target-that-does-not-exist', dangling, 'dir');
      const { res, pending } = await startClone({ workspacePath: dangling });
      await pending;

      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(lastEvent(res).type).toBe('error');
      expect(lastEvent(res).message).toContain('Workspace validation failed');
      expect(res.ended).toBe(true);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('does not call mkdir when pre-creation workspace validation fails', async () => {
    const mkdir = await mockMkdir(async (...args) => fs.mkdir(...args));
    const { res, pending } = await startClone({ workspacePath: '/etc/pilotdeck-validation-must-not-create' });
    await pending;

    expect(mkdir).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(lastEvent(res).type).toBe('error');
    expect(res.ended).toBe(true);
  });

  it('does not start Git when post-creation workspace validation fails', async () => {
    const mutableWorkspace = path.join(workspace, 'mutable');
    const preservedWorkspace = path.join(workspace, 'mutable-preserved');
    await fs.mkdir(mutableWorkspace);
    await fs.writeFile(path.join(mutableWorkspace, 'keep.txt'), 'keep me');
    await mockMkdir(async (target, options) => {
      await fs.mkdir(target, options);
      if (target === mutableWorkspace && options?.recursive) {
        await fs.rename(mutableWorkspace, preservedWorkspace);
        await fs.symlink('/etc/pilotdeck-post-validation-target-missing', mutableWorkspace, 'dir');
      }
    });

    const { res, pending } = await startClone({ workspacePath: mutableWorkspace });
    await pending;

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(preservedWorkspace, 'keep.txt'), 'utf8')).toBe('keep me');
    expect(lastEvent(res).type).toBe('error');
    expect(lastEvent(res).message).toContain('Workspace validation failed');
    expect(res.ended).toBe(true);
  });

  it('returns a terminal SSE error without starting Git when destination mkdir fails', async () => {
    await mockMkdir(async (target, options) => {
      if (options?.mode === 0o700) {
        const error = new Error('mkdir denied by test');
        error.code = 'EACCES';
        throw error;
      }
      return fs.mkdir(target, options);
    });
    const { res, pending } = await startClone();
    await pending;

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(lastEvent(res).type).toBe('error');
    expect(lastEvent(res).message).toContain('mkdir denied by test');
    expect(res.ended).toBe(true);
  });

  it('preserves an existing destination and never starts Git', async () => {
    const destination = path.join(workspace, 'PilotDeck');
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, 'keep.txt'), 'keep me');
    const { req, res, pending } = await startClone();

    await pending;

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8')).toBe('keep me');
    expect(lastEvent(res).type).toBe('error');
    expect(lastEvent(res).message).toContain('already exists');
    expect(res.ended).toBe(true);
  });

  it('cleans only the owned destination after a clone failure', async () => {
    const sibling = path.join(workspace, 'sibling.txt');
    await fs.writeFile(sibling, 'keep me');
    const { child, res, pending } = await startClone({ waitForSpawn: true });

    child.stderr.emit('data', 'clone failed');
    child.emit('close', 1);
    await pending;

    await expect(fs.access(path.join(workspace, 'PilotDeck'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(sibling, 'utf8')).toBe('keep me');
    expect(lastEvent(res).type).toBe('error');
    expect(res.ended).toBe(true);
  });

  it('allows only one concurrent request to reserve the same destination', async () => {
    const first = await startClone({ waitForSpawn: true });
    const second = await startClone();

    await second.pending;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(lastEvent(second.res).type).toBe('error');
    expect(lastEvent(second.res).message).toContain('already exists');

    first.child.emit('close', 0);
    await first.pending;
    expect(lastEvent(first.res).type).toBe('complete');
    expect(first.res.ended).toBe(true);
  });

  it('aborts Git, cleans its owned destination and ends SSE on disconnect', async () => {
    const { child, req, res, pending } = await startClone({ waitForSpawn: true });

    req.emit('close');
    await pending;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(fs.access(path.join(workspace, 'PilotDeck'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(lastEvent(res).type).toBe('error');
    expect(lastEvent(res).message).toContain('aborted');
    expect(res.ended).toBe(true);
  });

  it('preserves cloned data when project registration fails', async () => {
    mocks.addProjectManually.mockRejectedValueOnce(new Error('registration failed'));
    const { child, res, pending } = await startClone({ waitForSpawn: true });
    const destination = path.join(workspace, 'PilotDeck');
    await fs.writeFile(path.join(destination, 'cloned.txt'), 'cloned data');

    child.emit('close', 0);
    await pending;

    expect(await fs.readFile(path.join(destination, 'cloned.txt'), 'utf8')).toBe('cloned data');
    expect(lastEvent(res).type).toBe('error');
    expect(lastEvent(res).message).toContain('Clone succeeded but failed to add project');
    expect(res.ended).toBe(true);
  });
});

async function mockMkdir(implementation) {
  const mkdir = vi.fn(implementation);
  vi.doMock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, promises: { ...actual.promises, mkdir } };
  });
  return mkdir;
}

async function startClone({ waitForSpawn = false, workspacePath = workspace } = {}) {
  const module = await import('./projects.js');
  const handler = findRouteHandler(module.default, 'get', '/clone-progress');
  const cloneSessionId = module.createCloneSession({
    workspacePath,
    githubUrl: REPOSITORY_URL,
    githubToken: null,
    userId: 1,
  });
  const child = createChildProcess();
  mocks.spawn.mockReturnValueOnce(child);
  const req = new EventEmitter();
  req.query = { cloneSessionId };
  req.user = { id: 1 };
  const res = createSseResponse();
  const pending = handler(req, res);
  if (waitForSpawn) await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  return { child, req, res, pending };
}

function createChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit('close', null));
    return true;
  });
  return child;
}

async function loadRouteHandler(method, routePath) {
  const module = await import('./projects.js');
  return findRouteHandler(module.default, method, routePath);
}

function findRouteHandler(router, method, routePath) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
  return layer.route.stack.at(-1).handle;
}

function createJsonResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function createSseResponse() {
  return {
    events: [],
    ended: false,
    destroyed: false,
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    write(chunk) {
      this.events.push(JSON.parse(chunk.replace(/^data:\s*/, '')));
      return true;
    },
    end() {
      this.ended = true;
      this.writableEnded = true;
    },
  };
}

function lastEvent(res) {
  return res.events.at(-1);
}
