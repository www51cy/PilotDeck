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
  it('stays visible in the default state with muted labels', () => {
    render(
      <ComposerStatusBar
        runMode="agent"
        permissionMode="default"
        projectName="pilotdeck"
        t={t}
      />,
    );

    expect(screen.getByTestId('composer-statusbar')).toBeTruthy();
    expect(screen.getByTestId('composer-status-run-mode').textContent).toBe('Agent');
    expect(screen.getByTestId('composer-status-permission').textContent).toBe('Default');
    expect(screen.getByTestId('composer-status-workspace').textContent).toContain('pilotdeck');
  });

  it('highlights an active run mode', () => {
    render(<ComposerStatusBar runMode="plan" permissionMode="default" t={t} />);

    const badge = screen.getByTestId('composer-status-run-mode');
    expect(badge.textContent).toBe('Plan');
    expect(badge.className).toContain('violet');
  });

  it('highlights bypass permissions as a warning', () => {
    render(<ComposerStatusBar runMode="agent" permissionMode="bypassPermissions" t={t} />);

    const badge = screen.getByTestId('composer-status-permission');
    expect(badge.textContent).toBe('Full Access');
    expect(badge.className).toContain('amber');
  });

  it('omits the workspace segment when no project is selected', () => {
    render(<ComposerStatusBar runMode="ask" permissionMode="default" t={t} />);

    expect(screen.queryByTestId('composer-status-workspace')).toBeNull();
    expect(screen.getByTestId('composer-status-run-mode').textContent).toBe('Ask');
  });
});
