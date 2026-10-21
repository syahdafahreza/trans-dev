import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiError,
  TransClient,
  describeBrowser,
  normalizeHost,
  saveStoredHost,
  type StoredSession,
} from '../lib/api';
import type { DeviceInfo, PairInfo, ShareLocation } from '../lib/types';
import { Button } from './ui';
import { Icon } from './Icon';

interface PairingProps {
  initialHost: string;
  onPaired: (payload: { session: StoredSession; device: DeviceInfo; locations: ShareLocation[] }) => void;
}

export function Pairing({ initialHost, onPaired }: PairingProps) {
  const params = new URLSearchParams(window.location.search);
  const [host, setHost] = useState(initialHost);
  const [hostDraft, setHostDraft] = useState(initialHost);
  const [showHostField, setShowHostField] = useState(Boolean(initialHost) && initialHost !== '');
  const [digits, setDigits] = useState<string[]>(['', '', '', '']);
  const [info, setInfo] = useState<PairInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockSeconds, setLockSeconds] = useState(0);
  const [demoHint, setDemoHint] = useState(false);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const autoSubmitted = useRef(false);

  const fillPin = useCallback((pin: string) => {
    const clean = pin.replace(/\D/g, '').slice(0, 4);
    if (!clean) return;
    setDigits(Array.from({ length: 4 }, (_, index) => clean[index] ?? ''));
    if (clean.length === 4) inputs.current[3]?.focus();
  }, []);

  // Discover the device sitting on the other end of this origin (or ?host=).
  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setInfoError(null);
    TransClient.pairInfo(host)
      .then((payload) => {
        if (cancelled) return;
        setInfo(payload);
        // Demo host: it publishes its PIN so the flow can be tried without a phone.
        if (payload.demo && payload.pin && !params.get('code')) {
          fillPin(payload.pin);
          setDemoHint(true);
        }
      })
      .catch((exception) => {
        if (cancelled) return;
        setInfoError(exception instanceof Error ? exception.message : 'Device not reachable');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  useEffect(() => {
    const pinParam = params.get('pin');
    if (pinParam) fillPin(pinParam);
    const hostParam = params.get('host');
    if (hostParam) {
      const normalized = normalizeHost(hostParam);
      setHost(normalized);
      setHostDraft(normalized);
      setShowHostField(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (lockSeconds <= 0) return;
    const timer = window.setInterval(() => setLockSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [lockSeconds]);

  const pair = useCallback(
    async (payload: { pin?: string; code?: string }) => {
      if (pairing) return;
      setPairing(true);
      setError(null);
      try {
        const result = await TransClient.pair(host, { ...payload, clientName: describeBrowser() });
        const stored: StoredSession = {
          id: result.session.id,
          token: result.token,
          expiresAt: result.expiresAt,
          clientName: result.session.clientName,
          deviceName: result.device.name,
          baseUrl: host,
        };
        saveStoredHost(host);
        onPaired({ session: stored, device: result.device, locations: result.locations });
      } catch (exception) {
        const apiError = exception instanceof ApiError ? exception : null;
        setError(apiError?.message ?? 'Could not pair with that device.');
        setDigits(['', '', '', '']);
        inputs.current[0]?.focus();
        if (apiError?.status === 429) setLockSeconds(apiError.retryAfter ?? 30);
      } finally {
        setPairing(false);
      }
    },
    [host, onPaired, pairing],
  );

  // A QR link carries `?code=`; scanning it already proves proximity.
  useEffect(() => {
    const code = params.get('code');
    if (!code || autoSubmitted.current) return;
    autoSubmitted.current = true;
    void pair({ code });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const complete = digits.every((digit) => digit !== '');

  useEffect(() => {
    // In the demo the PIN is filled in for you; still let the user press Connect so the
    // pairing screen stays visible. A PIN arriving through a QR link auto-connects.
    if (complete && !pairing && !autoSubmitted.current && !params.get('code') && !demoHint) {
      autoSubmitted.current = true;
      void pair({ pin: digits.join('') }).finally(() => {
        autoSubmitted.current = false;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complete, demoHint]);

  function updateDigit(index: number, raw: string) {
    const clean = raw.replace(/\D/g, '');
    if (!clean) {
      setDigits((current) => current.map((value, i) => (i === index ? '' : value)));
      return;
    }
    if (clean.length > 1) {
      fillPin(clean);
      return;
    }
    setDigits((current) => current.map((value, i) => (i === index ? clean : value)));
    if (index < 3) inputs.current[index + 1]?.focus();
  }

  function onKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
    if (event.key === 'ArrowLeft' && index > 0) inputs.current[index - 1]?.focus();
    if (event.key === 'ArrowRight' && index < 3) inputs.current[index + 1]?.focus();
    if (event.key === 'Enter' && complete) void pair({ pin: digits.join('') });
  }

  function applyHost(value: string) {
    const normalized = normalizeHost(value);
    setHost(normalized);
    saveStoredHost(normalized);
    setShowHostField(false);
  }

  return (
    <div className="pairing">
      <section className="pairing__hero">
        <div className="brand brand--hero">
          <span className="brand__mark">
            <Icon name="zap" size={18} />
          </span>
          <span className="brand__name">TransDev</span>
        </div>

        <div className="hero__copy">
          <span className="hero__eyebrow">
            <Icon name="wifi" size={14} /> Local Wi-Fi transfer
          </span>
          <h1>
            Your phone,
            <br />
            on your desk.
          </h1>
          <p>
            Move photos, videos and documents between your phone and this computer at full Wi-Fi speed. Nothing
            touches the internet.
          </p>
        </div>

        <ul className="hero__points">
          <li>
            <span className="hero__point-icon">
              <Icon name="lock" size={15} />
            </span>
            <div>
              <strong>Private by design</strong>
              <span>Files travel directly over your local network.</span>
            </div>
          </li>
          <li>
            <span className="hero__point-icon">
              <Icon name="zap" size={15} />
            </span>
            <div>
              <strong>No size limits</strong>
              <span>Chunked streaming keeps 4 GB videos moving.</span>
            </div>
          </li>
          <li>
            <span className="hero__point-icon">
              <Icon name="scan" size={15} />
            </span>
            <div>
              <strong>Pair in seconds</strong>
              <span>Scan a QR code or type the 4-digit PIN.</span>
            </div>
          </li>
        </ul>

        <div className="hero__diagram" aria-hidden="true">
          <span className="device device--phone">
            <Icon name="phone" size={26} />
          </span>
          <span className="beam">
            <span className="beam__dot" />
          </span>
          <span className="device device--laptop">
            <Icon name="monitor" size={26} />
          </span>
        </div>
      </section>

      <section className="pairing__panel">
        <div className="pair-card">
          <header className="pair-card__head">
            <span className="pair-card__badge">
              <Icon name="wifi" size={13} />
              {info ? 'Device found' : infoError ? 'Not connected' : 'Searching…'}
            </span>
            <h2>Connect to your phone</h2>
            <p>
              On your phone, open <strong>TransDev</strong> and turn on the local server. Then enter the 4-digit code
              shown on its screen.
            </p>
          </header>

          <div className="device-chip">
            <span className="device-chip__icon">
              <Icon name="phone" size={20} />
            </span>
            <div className="device-chip__text">
              <strong>{info?.deviceName ?? (host ? 'Device at ' + host.replace(/^https?:\/\//, '') : 'This device')}</strong>
              <span>
                {info
                  ? `${info.network.address}:${info.network.port} · same Wi-Fi`
                  : infoError
                    ? 'No server answered on this address'
                    : 'Looking for a phone on your network…'}
              </span>
            </div>
            <span className={`status-dot ${info ? 'status-dot--on' : 'status-dot--off'}`} />
          </div>

          <div className="pin-block">
            <div className="pin-label">
              <span>Verification code</span>
              {demoHint && <span className="demo-badge">Demo PIN filled in</span>}
            </div>
            <div className="pin-inputs" onPaste={(event) => {
              event.preventDefault();
              fillPin(event.clipboardData.getData('text'));
            }}>
              {digits.map((digit, index) => (
                <input
                  key={index}
                  ref={(node) => {
                    inputs.current[index] = node;
                  }}
                  value={digit}
                  onChange={(event) => updateDigit(index, event.target.value)}
                  onKeyDown={(event) => onKeyDown(index, event)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={4}
                  aria-label={`Digit ${index + 1} of 4`}
                  className={digit ? 'pin-input pin-input--filled' : 'pin-input'}
                  autoFocus={index === 0}
                />
              ))}
            </div>
          </div>

          {error && (
            <div className="inline-error" role="alert">
              <Icon name="alert" size={16} />
              <span>{error}</span>
            </div>
          )}

          <Button
            variant="primary"
            className="pair-submit"
            icon="key"
            loading={pairing}
            disabled={!complete || lockSeconds > 0}
            onClick={() => void pair({ pin: digits.join('') })}
          >
            {lockSeconds > 0 ? `Try again in ${lockSeconds}s` : pairing ? 'Connecting…' : 'Connect to device'}
          </Button>

          <div className="pair-hint">
            {infoError ? (
              <span>
                Can’t find your phone? Make sure it is on the same Wi-Fi and that the server screen is open, then check
                the address below.
              </span>
            ) : (
              <span>
                Prefer the QR code? Open <strong>Scan QR</strong> on your phone and point it at the code on your phone
                screen.
              </span>
            )}
          </div>

          <button className="link-btn" onClick={() => setShowHostField((value) => !value)}>
            <Icon name={showHostField ? 'chevron-down' : 'chevron-right'} size={14} />
            Use a different address
          </button>

          {showHostField && (
            <form
              className="host-field"
              onSubmit={(event) => {
                event.preventDefault();
                applyHost(hostDraft);
              }}
            >
              <label htmlFor="host-input">Phone address</label>
              <div className="host-field__row">
                <input
                  id="host-input"
                  value={hostDraft}
                  onChange={(event) => setHostDraft(event.target.value)}
                  placeholder="192.168.1.24:8787"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                <Button type="submit" variant="secondary" size="sm">
                  Use
                </Button>
              </div>
              <span className="host-field__hint">Shown on your phone under the server status.</span>
            </form>
          )}
        </div>

        <footer className="pairing__foot">
          <span>
            <Icon name="shield" size={14} /> End-to-end on your LAN
          </span>
          <span className="dot-sep" />
          <span>No accounts · no cloud · no tracking</span>
        </footer>
      </section>
    </div>
  );
}
