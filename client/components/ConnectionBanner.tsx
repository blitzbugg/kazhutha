import type { ConnectionState } from '../state';

/** U5: a visible reconnecting state instead of a frozen screen. */
export function ConnectionBanner({ connection }: { connection: ConnectionState }) {
  if (connection !== 'reconnecting') return null;
  return (
    <div className="banner" role="alert">
      Reconnecting… your seat will be restored automatically.
    </div>
  );
}
