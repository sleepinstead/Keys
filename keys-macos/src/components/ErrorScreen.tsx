import { Component, useState } from 'react';
import type { ReactNode } from 'react';
import { ServerOff, TriangleAlert } from 'lucide-react';
import { Button } from './ui.tsx';

/** Full-page failure card, styled like the "can't open your database" screen. */
export function ErrorScreen({
  icon,
  title,
  message,
  detail,
  action,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  message: string;
  detail?: string;
  action: string;
  onAction: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onAction();
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="screen lock">
      <div className="lock-center">
        <section className="lock-card storage-missing" role="alertdialog" aria-labelledby="error-title" aria-describedby="error-message">
          <span className="storage-missing-icon" aria-hidden="true">
            {icon}
          </span>
          <h1 id="error-title" className="lock-title">
            {title}
          </h1>
          <p id="error-message" className="lock-lede">
            {message}
          </p>
          {detail && <code className="storage-missing-path">{detail}</code>}
          <div className="storage-missing-actions">
            <Button variant="primary" className="btn-block" loading={busy} onClick={() => void run()}>
              {action}
            </Button>
          </div>
        </section>
      </div>
    </main>
  );
}

export function ConnectionError({ detail, onRetry }: { detail: string; onRetry: () => Promise<void> }) {
  return (
    <ErrorScreen
      icon={<ServerOff size={22} />}
      title="Can’t reach Keys"
      message="Keys isn’t responding. Check that it’s still running, then try again."
      detail={detail}
      action="Try again"
      onAction={onRetry}
    />
  );
}

/** Replaces a blank page if the interface itself crashes. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorScreen
        icon={<TriangleAlert size={22} />}
        title="Something went wrong"
        message="Keys ran into a problem showing this page. Reloading usually fixes it."
        detail={this.state.error.message}
        action="Reload Keys"
        onAction={() => window.location.reload()}
      />
    );
  }
}
