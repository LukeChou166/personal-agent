import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from '@anthropic/ink';
import type { Props as REPLProps } from './screens/REPL.js';
import type { AppState } from './state/AppStateStore.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
import { learningLog } from './utils/learningLog.js';

type AppWrapperProps = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
};

export async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>,
): Promise<void> {
  const { App } = await import('./components/App.js');
  const { SentryErrorBoundary } = await import('./components/SentryErrorBoundary.js');
  const { REPL } = await import('./screens/REPL.js');
  learningLog('repl.launcher_loaded');
  learningLog('repl.root_initialized', { root, appProps, replProps });
  // Everything after this point is driven by Ink's render loop; renderAndRun
  // itself does not resolve until root.waitUntilExit() — i.e. session end.
  learningLog('repl.first_render');
  await renderAndRun(
    root,
    <SentryErrorBoundary name="RootREPLBoundary">
      <App {...appProps}>
        <REPL {...replProps} />
      </App>
    </SentryErrorBoundary>,
  );
}
