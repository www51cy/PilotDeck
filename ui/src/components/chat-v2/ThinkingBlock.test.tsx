import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThinkingBlock } from './ThinkingBlock';
afterEach(cleanup);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue }) }));
vi.mock('../chat/view/subcomponents/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('./StreamingScrollViewport', () => ({ StreamingScrollViewport: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
it('shows received content directly and collapses once on completion without replaying a prefix', () => {
  const { rerender, container } = render(<ThinkingBlock content="first complete chunk" isStreaming />);
  expect(container.textContent).toContain('first complete chunk');
  rerender(<ThinkingBlock content="first complete chunk and final words" isStreaming={false} />);
  const toggle = screen.getByRole('button', { name: 'Thought process' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(container.textContent).toContain('first complete chunk and final words');
  rerender(<ThinkingBlock content="first complete chunk and final words" isStreaming={false} />);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
});

it('preserves a manual expansion across completion and later streaming phases', () => {
  const { rerender } = render(<ThinkingBlock content="thinking" isStreaming />);
  const streamingToggle = screen.getByRole('button', { name: 'Thinking...' });
  fireEvent.click(streamingToggle);
  expect(streamingToggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(streamingToggle);
  expect(streamingToggle.getAttribute('aria-expanded')).toBe('true');

  rerender(<ThinkingBlock content="thinking completed" isStreaming={false} />);
  const completedToggle = screen.getByRole('button', { name: 'Thought process' });
  expect(completedToggle.getAttribute('aria-expanded')).toBe('true');

  rerender(<ThinkingBlock content="thinking resumed" isStreaming />);
  expect(screen.getByRole('button', { name: 'Thinking...' }).getAttribute('aria-expanded')).toBe('true');
  rerender(<ThinkingBlock content="thinking finished again" isStreaming={false} />);
  expect(screen.getByRole('button', { name: 'Thought process' }).getAttribute('aria-expanded')).toBe('true');
});
