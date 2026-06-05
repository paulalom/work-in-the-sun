import { Eye, EyeOff } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import type { PinGateState } from "./sessionCrypto";

interface PinGateProps {
  gate: PinGateState;
  busy: boolean;
  resetSignal: number;
  onSubmit: (pin: string) => Promise<void>;
}

export function PinGate({ gate, busy, resetSignal, onSubmit }: PinGateProps) {
  const [pin, setPin] = useState("");
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const enabled = gate.enabled && !busy;

  useEffect(() => {
    setPin("");
    setVisible(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [gate.visible, resetSignal]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(pin);
  }

  if (!gate.visible) {
    return null;
  }

  return (
    <section className="pin-gate">
      <form className="pin-panel" autoComplete="off" onSubmit={handleSubmit}>
        <p className="kicker">Work in the Sun</p>
        <h2>Enter Password</h2>
        <label className="sr-only" htmlFor="pinInput">
          Access password
        </label>
        <div className="pin-input-row">
          <input
            ref={inputRef}
            id="pinInput"
            name="password"
            type={visible ? "text" : "password"}
            autoComplete="current-password"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="go"
            placeholder="Password"
            disabled={!enabled}
            value={pin}
            onChange={(event) => setPin(event.target.value)}
          />
          <button
            className="pin-visibility-button icon-button"
            type="button"
            aria-label={visible ? "Hide password" : "Show password"}
            aria-pressed={visible}
            title={visible ? "Hide password" : "Show password"}
            disabled={!enabled}
            onClick={() => {
              setVisible((current) => !current);
              inputRef.current?.focus();
            }}
          >
            {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        </div>
        <button className="pin-submit-button" type="submit" disabled={!enabled}>
          Unlock
        </button>
        <details className="server-identity">
          <summary>Server identity</summary>
          <dl>
            <div>
              <dt>Version</dt>
              <dd>{gate.identity.version || "-"}</dd>
            </div>
            <div>
              <dt>Host</dt>
              <dd>{gate.identity.host || window.location.host || "-"}</dd>
            </div>
            <div>
              <dt>Fingerprint</dt>
              <dd>{gate.pinUnlock?.fingerprint || "-"}</dd>
            </div>
          </dl>
        </details>
        <p className="pin-message" aria-live="polite" title={gate.message}>
          {busy ? "Checking password." : gate.message}
        </p>
      </form>
    </section>
  );
}
