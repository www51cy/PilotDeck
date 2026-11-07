// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';

import { ComposerStatusBar } from './ComposerV2';

const t = ((key: string, options?: Record<string, unknown>) =>
  (options?.defaultValue as string | undefined) ?? key) as TFunction;

afterEach(cleanup);

describe('ComposerStatusBar', () => {
  it('renders nothing in the default state', () => {
    render(
      <ComposerStatusBar
        runMode="agent"
        permissionMode="default"
        projectName="only-project"
        projectCount={1}
        t={t}
      />,
    );

    expect(screen.queryByTestId('composer-statusbar')).toBeNull();
  });

  it('shows the active run mode without the full-access warning', () => {
    render(
      <ComposerStatusBar
        runMode="plan"
        permissionMode="default"
        projectName="only-project"
        projectCount={1}
        t={t}
      />,
    );

    expect(screen.getByTestId('composer-status-run-mode').textContent).toBe('Plan');
    expect(screen.queryByTestId('composer-status-full-access')).toBeNull();
    // A single project is implicit and stays hidden.
    expect(screen.queryByTestId('composer-status-workspace')).toBeNull();
  });

  it('warns on bypass permissions and names the workspace when several exist', () => {
    render(
      <ComposerStatusBar
        runMode="agent"
        permissionMode="bypassPermissions"
        projectName="pilotdeck"
        projectCount={3}
        t={t}
      />,
    );

    expect(screen.getByTestId('composer-status-full-access').textContent).toBe('Full Access');
    expect(screen.queryByTestId('composer-status-run-mode')).toBeNull();
    expect(screen.getByTestId('composer-status-workspace').textContent).toContain('pilotdeck');
  });

  it('shows all three badges at once when every condition holds', () => {
    render(
      <ComposerStatusBar
        runMode="ask"
        permissionMode="bypassPermissions"
        projectName="repo-a"
        projectCount={2}
        t={t}
      />,
    );

    expect(screen.getByTestId('composer-status-run-mode').textContent).toBe('Ask');
    expect(screen.getByTestId('composer-status-full-access')).toBeTruthy();
    expect(screen.getByTestId('composer-status-workspace').textContent).toContain('repo-a');
  });
});
