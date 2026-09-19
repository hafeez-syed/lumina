import { ApiError } from '@/app/api';

/**
 * A 501 is not an error state, it is the progress bar: the route exists in the contract
 * and the backend has not built it yet. Anything else is a real failure and says so.
 */
export function Problem({ error, what }: { error: unknown; what: string }) {
  if (!error) return null;

  if (error instanceof ApiError && error.notImplemented) {
    return (
      <div className="notice">
        <b>Not implemented yet</b> — {what}. Build the route in <code>apps/agent/</code>, then
        pass it through <code>apps/gateway/</code>. This message is your progress bar.
      </div>
    );
  }

  const status = error instanceof ApiError ? error.status : undefined;
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div className="notice bad">
      <b>{status ? `${status}` : 'Request failed'}</b> — {(error as Error).message}
      {requestId ? (
        <>
          {' '}
          <code>{requestId}</code> (grep both logs for it)
        </>
      ) : null}
    </div>
  );
}
