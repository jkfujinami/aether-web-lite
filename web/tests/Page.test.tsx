// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const received: any[] = [];
vi.mock('@aether/ui', () => ({
  AetherApp: (props: any) => {
    received.push(props);
    return <div>aether-app</div>;
  },
}));

import Page from '../src/app/page';

afterEach(() => {
  cleanup();
  received.length = 0;
});

describe('Web: ページ', () => {
  it('共通の AetherApp を Web のラベルで描画し、配信元の /ws を既定のトラッカーにする', async () => {
    render(<Page />);
    await waitFor(() => expect(screen.getByText('aether-app')).toBeTruthy());
    const props = received[received.length - 1];
    expect(props.badge).toBe('Web');
    const expected = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
    expect(props.defaultTrackerUrl).toBe(expected);
  });
});
