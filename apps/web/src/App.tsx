import { useCallback, useEffect, useMemo, useState } from 'react';

import { Dashboard } from './components/Dashboard';
import { Pairing } from './components/Pairing';
import { ToastStack, useToasts } from './components/ui';
import {
  ApiError,
  TransClient,
  currentHostFromLocation,
  loadStoredHost,
  loadStoredSession,
  saveStoredSession,
  type StoredSession,
} from './lib/api';
import type { ShareLocation } from './lib/types';

export default function App() {
  const { toasts, notify, dismiss } = useToasts();
  const [session, setSession] = useState<StoredSession | null>(() => loadStoredSession());
  const [locations, setLocations] = useState<ShareLocation[]>([]);
  const [checking, setChecking] = useState<boolean>(() => Boolean(loadStoredSession()));
  const [initialHost] = useState<string>(() => currentHostFromLocation() || loadStoredHost() || '');

  const client = useMemo(
    () => (session ? new TransClient(session.baseUrl, session.token) : null),
    [session],
  );

  // A token in sessionStorage can outlive the phone-side session (app restart, revoke).
  useEffect(() => {
    if (!session || !client) {
      setChecking(false);
      return;
    }
    let cancelled = false;
    client
      .session()
      .then((payload) => {
        if (cancelled) return;
        setLocations(payload.locations);
        setSession((current) =>
          current
            ? { ...current, id: payload.session.id, deviceName: payload.device.name, expiresAt: payload.session.expiresAt }
            : current,
        );
      })
      .catch((exception) => {
        if (cancelled) return;
        if (exception instanceof ApiError && (exception.status === 401 || exception.status === 0)) {
          saveStoredSession(null);
          setSession(null);
          notify({
            tone: 'error',
            title: 'Connection lost',
            message:
              exception.status === 0
                ? 'The phone is no longer reachable. Reconnect on the same Wi-Fi.'
                : 'This session expired. Pair with the phone again.',
          });
        }
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const handlePaired = useCallback(
    (payload: { session: StoredSession; locations: ShareLocation[] }) => {
      saveStoredSession(payload.session);
      setLocations(payload.locations);
      setSession(payload.session);
      setChecking(false);
      window.history.replaceState({}, '', window.location.pathname);
      notify({
        tone: 'success',
        title: 'Connected',
        message: `${payload.session.deviceName} is ready. Files stay on your Wi-Fi.`,
      });
    },
    [notify],
  );

  const handleDisconnect = useCallback(() => {
    saveStoredSession(null);
    setSession(null);
    setLocations([]);
    notify({ tone: 'info', title: 'Disconnected', message: 'The session token was removed from this browser.' });
  }, [notify]);

  if (checking) {
    return (
      <div className="boot">
        <span className="brand__mark brand__mark--lg">
          <span className="pulse-ring" />
        </span>
        <p>Reconnecting to your phone…</p>
      </div>
    );
  }

  return (
    <>
      {session && client ? (
        <Dashboard
          client={client}
          session={session}
          locations={locations}
          notify={notify}
          onDisconnect={handleDisconnect}
        />
      ) : (
        <Pairing initialHost={initialHost} onPaired={handlePaired} />
      )}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
