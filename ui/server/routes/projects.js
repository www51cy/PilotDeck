import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import {
  addProjectManually,
  extractProjectDirectory,
} from '../projects.js';
import {
  getProjectDiscoveryContext,
  getProjectDiscoveryPlansOverview,
  getProjectDiscoveryPlanReport,
  rerunDiscoveryPlan,
  getProjectWorkCycles,
  applyWorkCycle,
  archiveWorkCycle,
} from '../discovery-plans.js';
import { isPathInsideOrEqual, normalizePathForComparison } from '../utils/pathSafety.js';
import { isVirtualProjectPath, resolvePilotHome } from '../utils/pilotPaths.js';

const router = express.Router();

// Short-lived, single-use clone sessions. EventSource only supports GET URLs,
// so the SSE endpoint takes a session id instead of the GitHub token itself;
// the token travels in the POST body and is never placed in a URL.
const CLONE_SESSION_TTL_MS = 5 * 60 * 1000;
const cloneSessions = new Map();

export function createCloneSession(data, ttlMs = CLONE_SESSION_TTL_MS) {
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + ttlMs;
  const expirationTimer = setTimeout(() => cloneSessions.delete(id), Math.max(0, ttlMs));
  expirationTimer.unref?.();
  cloneSessions.set(id, { ...data, expiresAt, expirationTimer });
  return id;
}

export function takeCloneSession(id, userId) {
  const session = cloneSessions.get(id);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    clearTimeout(session.expirationTimer);
    cloneSessions.delete(id);
    return null;
  }
  // A different authenticated user must neither use nor consume the session.
  if (userId !== undefined && session.userId !== userId) return null;
  clearTimeout(session.expirationTimer);
  cloneSessions.delete(id);
  const { expirationTimer, ...data } = session;
  return data;
}

const GITHUB_HOSTNAME = 'github.com';
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

function invalidRepositoryUrl(message) {
  const error = new Error(message);
  error.code = 'INVALID_REPOSITORY_URL';
  return error;
}

function createCloneAbortError() {
  const error = new Error('Git clone aborted.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function parseRepositoryName(pathname) {
  let segments;
  try {
    segments = pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    throw invalidRepositoryUrl('GitHub URL contains invalid path encoding');
  }
  if (segments.length !== 2) {
    throw invalidRepositoryUrl('GitHub URL must identify an owner and repository');
  }
  const [owner, repository] = segments;
  const repoName = repository.endsWith('.git') ? repository.slice(0, -4) : repository;
  if (
    !REPOSITORY_SEGMENT_PATTERN.test(owner)
    || !REPOSITORY_SEGMENT_PATTERN.test(repoName)
    || owner === '.' || owner === '..'
    || repoName === '.' || repoName === '..'
  ) {
    throw invalidRepositoryUrl('GitHub URL contains an invalid owner or repository name');
  }
  return repoName;
}

export function parseGitHubRepository(githubUrl) {
  if (typeof githubUrl !== 'string' || !githubUrl.trim()) {
    throw invalidRepositoryUrl('A GitHub repository URL is required');
  }
  const cloneUrl = githubUrl.trim();
  const scpLike = cloneUrl.includes('://') ? null : /^(?:[\w.-]+@)?([\w.-]+):([^\s]+)$/.exec(cloneUrl);
  let protocol;
  let hostname;
  let pathname;
  let origin;

  if (scpLike) {
    protocol = 'ssh:';
    hostname = scpLike[1].toLowerCase();
    pathname = scpLike[2];
    origin = `ssh://${hostname}`;
  } else {
    let url;
    try {
      url = new URL(cloneUrl);
    } catch {
      throw invalidRepositoryUrl('Git URL must use HTTP(S) or SSH');
    }
    protocol = url.protocol;
    if (!['http:', 'https:', 'ssh:'].includes(protocol)) {
      throw invalidRepositoryUrl('Git URL must use HTTP(S) or SSH');
    }
    hostname = url.hostname.toLowerCase();
    if (url.port) throw invalidRepositoryUrl('GitHub URL must use the default service port');
    if (protocol !== 'ssh:' && (url.username || url.password)) {
      throw invalidRepositoryUrl('Credentials must not be embedded in the repository URL');
    }
    if (url.search || url.hash) {
      throw invalidRepositoryUrl('GitHub URL must not contain a query string or fragment');
    }
    pathname = url.pathname;
    origin = url.origin;
  }

  if (hostname !== GITHUB_HOSTNAME) {
    throw invalidRepositoryUrl('Only repositories hosted on github.com are supported');
  }
  return { cloneUrl, repoName: parseRepositoryName(pathname), protocol, origin };
}

function sanitizeGitError(message, token) {
  if (!message) return message;
  if (!token) return message;
  let sanitized = message;
  const secrets = new Set([token, encodeURIComponent(token), Buffer.from(`${token}:`).toString('base64')]);
  for (const secret of secrets) {
    if (!secret) continue;
    sanitized = sanitized.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***');
  }
  return sanitized;
}

// Default root used by the folder browser when no path is provided.
export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || os.homedir();

// System-critical paths that should never be used as workspace directories
export const FORBIDDEN_PATHS = [
  // Unix
  '/',
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/dev',
  '/proc',
  '/sys',
  '/var',
  '/boot',
  '/root',
  '/lib',
  '/lib64',
  '/opt',
  '/run',
  // Windows
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\System Volume Information',
  'C:\\$Recycle.Bin'
];

function isForbiddenWorkspacePath(inputPath) {
  const normalizedPath = path.normalize(path.resolve(inputPath));
  const comparablePath = normalizePathForComparison(inputPath);
  if (normalizedPath === '/') {
    return true;
  }

  const homeDir = normalizePathForComparison(os.homedir());
  if (comparablePath === homeDir) return true;

  const pilotHome = normalizePathForComparison(resolvePilotHome(process.env));
  if (isPathInsideOrEqual(pilotHome, comparablePath) || isPathInsideOrEqual(comparablePath, pilotHome)) {
    return true;
  }

  for (const forbidden of FORBIDDEN_PATHS) {
    const comparableForbidden = normalizePathForComparison(forbidden);
    if (comparablePath === comparableForbidden || comparablePath.startsWith(comparableForbidden + path.sep)) {
      // The home directory itself is off-limits, but its subdirectories are
      // valid workspace locations — the folder browser defaults to home, so
      // forbidding descendants would reject every default-issued path.
      if (comparableForbidden === homeDir && comparablePath !== homeDir) {
        continue;
      }
      // Exception: allow user-accessible temporary folders under /var.
      if (
        forbidden === '/var' &&
        (
          comparablePath.startsWith(normalizePathForComparison('/var/tmp')) ||
          comparablePath.startsWith(normalizePathForComparison('/var/folders'))
        )
      ) {
        continue;
      }
      return true;
    }
  }

  return false;
}

async function resolveThroughExistingAncestor(absolutePath) {
  const missingSegments = [];
  let current = absolutePath;

  while (true) {
    try {
      const realAncestor = await fs.realpath(current);
      return path.join(realAncestor, ...missingSegments);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      let stats;
      try {
        stats = await fs.lstat(current);
      } catch (lstatError) {
        if (lstatError.code !== 'ENOENT') throw lstatError;
      }
      if (stats?.isSymbolicLink()) {
        throw new Error(`Cannot resolve symbolic link in workspace path: ${current}`);
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Validates that a path is safe for workspace operations
 * @param {string} requestedPath - The path to validate
 * @returns {Promise<{valid: boolean, resolvedPath?: string, error?: string}>}
 */
export async function validateWorkspacePath(requestedPath) {
  try {
    // Resolve to absolute path
    let absolutePath = path.resolve(requestedPath);

    // Reject system-critical directories and descendants.
    if (isForbiddenWorkspacePath(absolutePath)) {
      return {
        valid: false,
        error: 'Cannot create workspace in system-critical directories'
      };
    }

    // Resolve the nearest existing ancestor, then restore the missing tail.
    // Checking only the direct parent would let a symlink followed by a
    // non-existent intermediate directory hide a forbidden real target.
    const realPath = await resolveThroughExistingAncestor(absolutePath);

    // Apply the same checks after symlink/canonical path resolution.
    if (isForbiddenWorkspacePath(realPath)) {
      return {
        valid: false,
        error: 'Resolved path points to a system-critical directory'
      };
    }

    // Additional symlink check for existing paths
    try {
      await fs.access(absolutePath);
      const stats = await fs.lstat(absolutePath);

      if (stats.isSymbolicLink()) {
        // Verify symlink target is not a forbidden system path.
        const linkTarget = await fs.readlink(absolutePath);
        const resolvedTarget = path.resolve(path.dirname(absolutePath), linkTarget);
        const realTarget = await fs.realpath(resolvedTarget);

        if (isForbiddenWorkspacePath(realTarget)) {
          return {
            valid: false,
            error: 'Symlink target points to a system-critical directory'
          };
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // Path doesn't exist - that's fine for new workspace creation
    }

    return {
      valid: true,
      resolvedPath: realPath
    };

  } catch (error) {
    return {
      valid: false,
      error: `Path validation failed: ${error.message}`
    };
  }
}

function getTrimmedParam(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getDiscoveryPlanErrorMessage(error, fallback) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

function getDiscoveryPlanErrorStatus(error) {
  if (error?.code === 'NOT_FOUND') {
    return 404;
  }
  if (error?.code === 'UNSUPPORTED_STRATEGY') {
    return 400;
  }
  if (error?.code === 'INVALID_STATE' || error?.code === 'MISSING_PLAN_BODY' || error?.code === 'MISSING_WORKSPACE') {
    return 409;
  }
  if (error?.code === 'ALREADY_RUNNING') {
    return 409;
  }
  return 500;
}

async function requireRealProjectWorkspace(req, res, next) {
  try {
    const projectPath = await extractProjectDirectory(req.params?.projectName);
    if (isVirtualProjectPath(projectPath, resolvePilotHome(process.env), process.env)) {
      return res.status(403).json({
        error: {
          code: 'PROJECT_PATH_FORBIDDEN',
          message: 'Project exploration is unavailable for General conversations.',
        },
      });
    }
    return next();
  } catch (error) {
    return res.status(404).json({
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: error instanceof Error ? error.message : 'Project not found',
      },
    });
  }
}

export async function handleGetProjectDiscoveryPlans(req, res) {
  try {
    const projectName = getTrimmedParam(req.params?.projectName);
    if (!projectName) {
      return res.status(400).json({ error: 'projectName is required' });
    }

    const overview = await getProjectDiscoveryPlansOverview(projectName);
    return res.json(overview);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

export async function handleGetProjectDiscoveryContext(req, res) {
  try {
    const projectName = getTrimmedParam(req.params?.projectName);
    if (!projectName) {
      return res.status(400).json({ error: 'projectName is required' });
    }

    const context = await getProjectDiscoveryContext(projectName);
    return res.json(context);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

export async function handleExecuteProjectDiscoveryPlan(req, res) {
  try {
    const projectName = getTrimmedParam(req.params?.projectName);
    const planId = getTrimmedParam(req.params?.planId);
    if (!projectName) {
      return res.status(400).json({ error: 'projectName is required' });
    }
    if (!planId) {
      return res.status(400).json({ error: 'planId is required' });
    }

    const result = await rerunDiscoveryPlan(projectName, planId);
    return res.json(result);
  } catch (error) {
    return res.status(getDiscoveryPlanErrorStatus(error)).json({
      error: getDiscoveryPlanErrorMessage(error, 'Failed to rerun discovery plan')
    });
  }
}

router.get('/:projectName/discovery-context', requireRealProjectWorkspace, handleGetProjectDiscoveryContext);
router.get('/:projectName/discovery-plans', requireRealProjectWorkspace, handleGetProjectDiscoveryPlans);
router.post('/:projectName/discovery-plans/:planId/execute', requireRealProjectWorkspace, handleExecuteProjectDiscoveryPlan);

router.get('/:projectName/discovery-plans/:planId/report', requireRealProjectWorkspace, async (req, res) => {
  try {
    const projectName = getTrimmedParam(req.params?.projectName);
    const planId = getTrimmedParam(req.params?.planId);
    if (!projectName) return res.status(400).json({ error: 'projectName is required' });
    if (!planId) return res.status(400).json({ error: 'planId is required' });

    const result = await getProjectDiscoveryPlanReport(projectName, planId);
    return res.json(result);
  } catch (error) {
    return res.status(getDiscoveryPlanErrorStatus(error)).json({
      error: getDiscoveryPlanErrorMessage(error, 'Failed to read discovery plan report')
    });
  }
});

router.get('/:projectName/work-cycles', requireRealProjectWorkspace, async (req, res) => {
  try {
    const projectName = getTrimmedParam(req.params?.projectName);
    if (!projectName) return res.status(400).json({ error: 'projectName is required' });

    const result = await getProjectWorkCycles(projectName);
    return res.json(result);
  } catch (error) {
    return res.status(getDiscoveryPlanErrorStatus(error)).json({
      error: getDiscoveryPlanErrorMessage(error, 'Failed to get work cycles')
    });
  }
});

router.post('/:projectName/work-cycles/:cycleId/apply', requireRealProjectWorkspace, async (req, res) => {
  try {
    const projectName = getTrimmedParam(req.params?.projectName);
    const cycleId = getTrimmedParam(req.params?.cycleId);
    if (!projectName) return res.status(400).json({ error: 'projectName is required' });
    if (!cycleId) return res.status(400).json({ error: 'cycleId is required' });

    const result = await applyWorkCycle(projectName, cycleId);
    return res.json(result);
  } catch (error) {
    return res.status(getDiscoveryPlanErrorStatus(error)).json({
      error: getDiscoveryPlanErrorMessage(error, 'Failed to apply work cycle')
    });
  }
});

router.post('/:projectName/work-cycles/:cycleId/archive', requireRealProjectWorkspace, async (req, res) => {
  try {
    const projectName = getTrimmedParam(req.params?.projectName);
    const cycleId = getTrimmedParam(req.params?.cycleId);
    if (!projectName) return res.status(400).json({ error: 'projectName is required' });
    if (!cycleId) return res.status(400).json({ error: 'cycleId is required' });

    const result = await archiveWorkCycle(projectName, cycleId);
    return res.json(result);
  } catch (error) {
    return res.status(getDiscoveryPlanErrorStatus(error)).json({
      error: getDiscoveryPlanErrorMessage(error, 'Failed to archive work cycle')
    });
  }
});

/**
 * Create a new workspace
 * POST /api/projects/create-workspace
 *
 * Body:
 * - workspaceType: 'existing' | 'new'
 * - path: string (workspace path)
 * - githubUrl?: string (optional, for new workspaces)
 * - githubTokenId?: number (optional, ID of stored token)
 * - newGithubToken?: string (optional, one-time token)
 */
router.post('/create-workspace', async (req, res) => {
  try {
    const { workspaceType, path: workspacePath, githubUrl, githubTokenId, newGithubToken } = req.body;

    // Validate required fields
    if (!workspaceType || !workspacePath) {
      return res.status(400).json({ error: 'workspaceType and path are required' });
    }

    if (!['existing', 'new'].includes(workspaceType)) {
      return res.status(400).json({ error: 'workspaceType must be "existing" or "new"' });
    }

    // Validate path safety before any operations
    const validation = await validateWorkspacePath(workspacePath);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid workspace path',
        details: validation.error
      });
    }

    const absolutePath = validation.resolvedPath;

    // Handle existing workspace
    if (workspaceType === 'existing') {
      // Check if the path exists
      try {
        await fs.access(absolutePath);
        const stats = await fs.stat(absolutePath);

        if (!stats.isDirectory()) {
          return res.status(400).json({ error: 'Path exists but is not a directory' });
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({ error: 'Workspace path does not exist' });
        }
        throw error;
      }

      // Add the existing workspace to the project list
      const project = await addProjectManually(absolutePath);

      return res.json({
        success: true,
        project,
        message: 'Existing workspace added successfully'
      });
    }

    // Handle new workspace creation
    if (workspaceType === 'new') {
      // Resolve the GitHub token before touching the filesystem. The workspace
      // path may be an existing parent directory (e.g. ~/dev) that holds other
      // projects, so a failed lookup must never lead to cleaning it up.
      let githubToken = null;
      if (githubUrl) {
        if (githubTokenId) {
          const token = await getGithubTokenById(githubTokenId, req.user.id);
          if (!token) {
            return res.status(404).json({ error: 'GitHub token not found' });
          }
          githubToken = token.github_token;
        } else if (newGithubToken) {
          githubToken = newGithubToken;
        }
      }

      // Create the directory if it doesn't exist
      await fs.mkdir(absolutePath, { recursive: true });

      // If GitHub URL is provided, clone the repository
      if (githubUrl) {
        // Extract repo name from URL for the clone destination
        const normalizedUrl = githubUrl.replace(/\/+$/, '').replace(/\.git$/, '');
        const repoName = normalizedUrl.split('/').pop() || 'repository';
        const clonePath = path.join(absolutePath, repoName);

        // Check if clone destination already exists to prevent data loss
        try {
          await fs.access(clonePath);
          return res.status(409).json({
            error: 'Directory already exists',
            details: `The destination path "${clonePath}" already exists. Please choose a different location or remove the existing directory.`
          });
        } catch (err) {
          // Directory doesn't exist, which is what we want
        }

        // Clone the repository into a subfolder
        try {
          await cloneGitHubRepository(githubUrl, clonePath, githubToken);
        } catch (error) {
          // Only clean up if clone created partial data (check if dir exists and is empty or partial)
          try {
            const stats = await fs.stat(clonePath);
            if (stats.isDirectory()) {
              await fs.rm(clonePath, { recursive: true, force: true });
            }
          } catch (cleanupError) {
            // Directory doesn't exist or cleanup failed - ignore
          }
          throw new Error(`Failed to clone repository: ${error.message}`);
        }

        // Add the cloned repo path to the project list
        const project = await addProjectManually(clonePath);

        return res.json({
          success: true,
          project,
          message: 'New workspace created and repository cloned successfully'
        });
      }

      // Add the new workspace to the project list (no clone)
      const project = await addProjectManually(absolutePath);

      return res.json({
        success: true,
        project,
        message: 'New workspace created successfully'
      });
    }

  } catch (error) {
    console.error('Error creating workspace:', error);
    res.status(500).json({
      error: error.message || 'Failed to create workspace',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * Helper function to get GitHub token from database
 */
async function getGithubTokenById(tokenId, userId) {
  const { db } = await import('../database/db.js');

  const credential = db.prepare(
    'SELECT * FROM user_credentials WHERE id = ? AND user_id = ? AND credential_type = ? AND is_active = 1'
  ).get(tokenId, userId, 'github_token');

  // Return in the expected format (github_token field for compatibility)
  if (credential) {
    return {
      ...credential,
      github_token: credential.credential_value
    };
  }

  return null;
}

/**
 * Clone repository with progress streaming (SSE)
 * POST /api/projects/clone-sessions
 * Validate the clone request and resolve credentials in a JSON body, then
 * return a single-use session id for the SSE clone-progress endpoint.
 */
router.post('/clone-sessions', async (req, res) => {
  try {
    const { path: workspacePath, githubUrl, githubTokenId, newGithubToken } = req.body ?? {};
    if (!workspacePath || !githubUrl) {
      return res.status(400).json({ error: 'path and githubUrl are required' });
    }
    const repository = parseGitHubRepository(githubUrl);

    const validation = await validateWorkspacePath(workspacePath);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    let githubToken = null;
    if (githubTokenId) {
      const token = await getGithubTokenById(parseInt(githubTokenId), req.user.id);
      if (!token) {
        return res.status(404).json({ error: 'GitHub token not found' });
      }
      githubToken = token.github_token;
    } else if (newGithubToken) {
      githubToken = newGithubToken;
    }
    if (githubToken && repository.protocol === 'http:') {
      return res.status(400).json({ error: 'GitHub token authentication requires HTTPS' });
    }

    const cloneSessionId = createCloneSession({
      workspacePath: validation.resolvedPath,
      githubUrl: repository.cloneUrl,
      githubToken,
      userId: req.user.id,
    });
    res.json({ cloneSessionId });
  } catch (error) {
    const status = error.code === 'INVALID_REPOSITORY_URL' ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to prepare repository clone' });
  }
});

/**
 * GET /api/projects/clone-progress
 */
router.get('/clone-progress', async (req, res) => {
  const { cloneSessionId } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const abortController = new AbortController();
  const sendEvent = (type, data) => {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    } catch {
      abortController.abort();
    }
  };
  const endResponse = () => {
    if (res.destroyed || res.writableEnded) return;
    try { res.end(); } catch { /* The peer may already have disconnected. */ }
  };

  let session;
  try {
    session = typeof cloneSessionId === 'string' ? takeCloneSession(cloneSessionId, req.user.id) : null;
  } catch (error) {
    sendEvent('error', { message: error.message });
    endResponse();
    return;
  }
  if (!session) {
    sendEvent('error', { message: 'Clone session is invalid or has expired. Please try again.' });
    endResponse();
    return;
  }
  const { workspacePath: absolutePath, githubUrl, githubToken } = session;
  const abortClone = () => abortController.abort();
  req.once('close', abortClone);
  let ownedClonePath = null;
  let failure = null;
  let project = null;

  try {
    const repository = parseGitHubRepository(githubUrl);
    if (githubToken && repository.protocol === 'http:') {
      throw invalidRepositoryUrl('GitHub token authentication requires HTTPS');
    }
    const workspaceRoot = path.resolve(absolutePath);
    const confirmWorkspace = async () => {
      const confirmed = await validateWorkspacePath(workspaceRoot);
      if (!confirmed.valid) {
        throw new Error(`Workspace validation failed before cloning: ${confirmed.error}`);
      }
      if (normalizePathForComparison(confirmed.resolvedPath) !== normalizePathForComparison(workspaceRoot)) {
        throw new Error('Workspace path changed during clone preparation');
      }
    };
    // Validate both sides of directory creation. A dangling or replaced link
    // must be rejected before mkdir can write through it.
    await confirmWorkspace();
    await fs.mkdir(workspaceRoot, { recursive: true });
    await confirmWorkspace();
    const clonePath = path.join(workspaceRoot, repository.repoName);
    if (
      clonePath === workspaceRoot
      || path.dirname(clonePath) !== workspaceRoot
      || !isPathInsideOrEqual(workspaceRoot, clonePath)
    ) {
      throw new Error('Repository destination escapes the selected workspace');
    }

    try {
      // mkdir is the atomic no-overwrite reservation. Only its successful
      // creator is allowed to clean up this destination.
      await fs.mkdir(clonePath, { mode: 0o700 });
      ownedClonePath = clonePath;
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(`Directory "${repository.repoName}" already exists. Please choose a different location or remove the existing directory.`);
      }
      throw error;
    }

    sendEvent('progress', { message: `Cloning into '${repository.repoName}'...` });
    await cloneGitHubRepository(githubUrl, clonePath, githubToken, {
      signal: abortController.signal,
      onProgress: (message) => {
        const trimmed = message.trim();
        if (trimmed) sendEvent('progress', { message: trimmed });
      },
    });
    // A successful clone is user data. Registration failure must not delete it.
    ownedClonePath = null;
    try {
      project = await addProjectManually(clonePath);
    } catch (error) {
      throw new Error(`Clone succeeded but failed to add project: ${error.message}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (ownedClonePath) {
      try {
        await fs.rm(ownedClonePath, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('Failed to clean up after clone failure:', sanitizeGitError(cleanupError.message, githubToken));
        if (!failure) failure = cleanupError;
      }
    }
    req.removeListener('close', abortClone);
  }

  if (failure) {
    sendEvent('error', { message: sanitizeGitError(failure.message, githubToken) || 'Git clone failed' });
  } else {
    sendEvent('complete', { project, message: 'Repository cloned successfully' });
  }
  endResponse();
});

/**
 * Helper function to clone a GitHub repository
 */
export function cloneGitHubRepository(githubUrl, destinationPath, githubToken = null, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(createCloneAbortError());
    let repository;
    try {
      repository = parseGitHubRepository(githubUrl);
    } catch (error) {
      return reject(error);
    }

    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0'
    };
    const parsedCount = Number(env.GIT_CONFIG_COUNT ?? '0');
    let configIndex = Number.isInteger(parsedCount) && parsedCount >= 0 ? parsedCount : 0;
    const addGitConfig = (key, value) => {
      env[`GIT_CONFIG_KEY_${configIndex}`] = key;
      env[`GIT_CONFIG_VALUE_${configIndex}`] = value;
      configIndex += 1;
      env.GIT_CONFIG_COUNT = String(configIndex);
    };
    if (githubToken && repository.protocol === 'http:') {
      return reject(invalidRepositoryUrl('GitHub token authentication requires HTTPS'));
    }
    if (githubToken && repository.protocol === 'https:') {
      // Scope credentials to github.com and disable redirects while a token is
      // attached, so credentials cannot be forwarded to a different origin.
      const authorization = Buffer.from(`${githubToken}:`).toString('base64');
      addGitConfig(`http.${repository.origin}/.extraHeader`, `Authorization: Basic ${authorization}`);
      addGitConfig('http.followRedirects', 'false');
    }

    const gitProcess = spawn('git', ['clone', '--progress', '--', repository.cloneUrl, destinationPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: process.platform === 'win32'
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminationError = null;
    let forceKillTimer;
    let timeout;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5 * 60 * 1000;

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', abortClone);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      try { gitProcess.kill('SIGTERM'); } catch { /* The forced exit below must still run. */ }
      if (settled) return;
      forceKillTimer = setTimeout(() => {
        try { gitProcess.kill('SIGKILL'); } catch { /* Settle even if the process is already gone. */ }
        finally { finish(terminationError); }
      }, 5_000);
      forceKillTimer.unref?.();
    };
    const abortClone = () => terminate(createCloneAbortError());
    const reportProgress = (data) => {
      try {
        options.onProgress?.(sanitizeGitError(data.toString(), githubToken));
      } catch (error) {
        terminate(error);
      }
    };
    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
      reportProgress(data);
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      reportProgress(data);
    });

    gitProcess.on('close', (code) => {
      if (terminationError) return finish(terminationError);
      if (code === 0) {
        finish(null, { stdout, stderr });
      } else {
        let errorMessage = 'Git clone failed';

        if (stderr.includes('Authentication failed') || stderr.includes('could not read Username')) {
          errorMessage = 'Authentication failed. Please check your GitHub token.';
        } else if (stderr.includes('Repository not found')) {
          errorMessage = 'Repository not found. Please check the URL and ensure you have access.';
        } else if (stderr.includes('already exists')) {
          errorMessage = 'Directory already exists';
        } else if (stderr) {
          errorMessage = sanitizeGitError(stderr, githubToken);
        }

        finish(new Error(errorMessage));
      }
    });

    gitProcess.on('error', (error) => {
      if (terminationError) return finish(terminationError);
      if (error.code === 'ENOENT') {
        finish(new Error('Git is not installed or not in PATH'));
      } else {
        finish(error);
      }
    });

    timeout = setTimeout(() => {
      const error = new Error(`Git clone timed out after ${timeoutMs}ms.`);
      error.code = 'GIT_CLONE_TIMEOUT';
      terminate(error);
    }, timeoutMs);
    timeout.unref?.();

    // Register immediately after spawn, then check again to close the race
    // between the initial pre-spawn check and listener registration.
    if (options.signal?.aborted) abortClone();
    else options.signal?.addEventListener('abort', abortClone, { once: true });
  });
}

export default router;
