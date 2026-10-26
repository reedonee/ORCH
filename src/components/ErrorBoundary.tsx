import { Component, type ReactNode } from 'react';
import { reportRendererError } from '../lib/electron-api';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Without this the error is swallowed by the boundary and never
    // reaches the console, which makes a blank canvas impossible to debug.
    console.error('[ErrorBoundary] Caught render error:', error, info.componentStack);
    // Persist it too — a console message is gone the moment the user
    // closes DevTools, and most users never open them.
    reportRendererError(error.message, error.stack, {
      componentStack: info.componentStack?.slice(0, 4000),
    }).catch(() => {});
  }

  override render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div
            style={{
              padding: 16,
              color: 'var(--error, #ef4444)',
              fontSize: 13,
              textAlign: 'center',
            }}
          >
            Terminal error
          </div>
        )
      );
    }
    return this.props.children;
  }
}
