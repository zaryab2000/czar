"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Device, PairingCode } from "@czar/schemas";
import { appApi } from "#src/app-api";

export default function DevicesPage() {
  const [devices, setDevices] = useState<readonly Device[]>([]);
  const [pairingCode, setPairingCode] = useState<PairingCode>();
  const [revokeTarget, setRevokeTarget] = useState<Device>();
  const [actionError, setActionError] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const requestInFlight = useRef(false);

  const loadDevices = useCallback(async (pageCursor?: string, append = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    setLoadError(undefined);
    try {
      const page = await appApi.listDevices(pageCursor);
      setDevices((current) => mergeDevices(current, page.items, append));
      setNextCursor(page.nextCursor);
    } catch {
      setLoadError("Czar could not load current devices. Check the connection and retry.");
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  async function issueCode() {
    setActionError(undefined);
    try {
      setPairingCode(await appApi.createPairingCode());
    } catch {
      setActionError("Czar could not create a pairing code. Try again.");
    }
  }

  async function revokeDevice() {
    if (!revokeTarget) return;
    setActionError(undefined);
    try {
      await appApi.revokeDevice(revokeTarget.deviceId);
      setRevokeTarget(undefined);
      setPairingCode(undefined);
      void loadDevices();
    } catch {
      setActionError("Czar could not revoke this device. Try again.");
    }
  }

  function loadMore() {
    if (nextCursor) void loadDevices(nextCursor, true);
  }

  function reloadDevices() {
    void loadDevices();
  }

  return (
    <section className="page-stack">
      <h1 className="czar-title">Devices</h1>
      <p>Pair your computer to let it send work to Czar. You can revoke a device at any time.</p>
      <button className="primary-link" onClick={issueCode} type="button">
        Pair a computer
      </button>
      {pairingCode && <PairingCodePanel pairingCode={pairingCode} />}
      {(loadError || actionError) && (
        <div className="error-panel" role="alert">
          <p>{actionError ?? loadError}</p>
          {loadError && (
            <button onClick={reloadDevices} type="button">
              Try again
            </button>
          )}
        </div>
      )}
      <h2>Paired devices</h2>
      <button onClick={reloadDevices} type="button">
        Refresh devices
      </button>
      {loading && <p role="status">Loading devices…</p>}
      {devices.map((device) => (
        <DeviceRow device={device} key={device.deviceId} onRevoke={setRevokeTarget} />
      ))}
      {!loading && devices.length === 0 && !loadError && <p>No paired devices yet.</p>}
      {nextCursor && (
        <button onClick={loadMore} type="button">
          Load more devices
        </button>
      )}
      {revokeTarget && (
        <RevokeConfirmation
          device={revokeTarget}
          onCancel={() => setRevokeTarget(undefined)}
          onConfirm={revokeDevice}
        />
      )}
    </section>
  );
}

function mergeDevices(
  current: readonly Device[],
  incoming: readonly Device[],
  append: boolean,
): readonly Device[] {
  if (!append) return incoming;
  const devices = new Map(current.map((device) => [device.deviceId, device]));
  for (const device of incoming) devices.set(device.deviceId, device);
  return [...devices.values()];
}

function PairingCodePanel({ pairingCode }: { readonly pairingCode: PairingCode }) {
  const minutes = Math.max(1, Math.ceil((Date.parse(pairingCode.expiresAt) - Date.now()) / 60_000));
  return (
    <div className="panel" role="status">
      <p>
        Enter this code in Czar on your computer: <strong>{pairingCode.code}</strong>. It expires in{" "}
        {minutes} minutes.
      </p>
      <time dateTime={pairingCode.expiresAt}>Expires at {pairingCode.expiresAt}</time>
    </div>
  );
}

/** SCR-181 §1: the browser device is listed with this label; it cannot be paired. */
const WEB_DEVICE_LABEL = "Browser (tasks you start on the web)";

function DeviceRow({
  device,
  onRevoke,
}: {
  readonly device: Device;
  readonly onRevoke: (device: Device) => void;
}) {
  const revoked = device.revokedAt !== undefined;
  return (
    <article className="panel">
      <h3>{device.platform === "web" ? WEB_DEVICE_LABEL : device.deviceName}</h3>
      <p>{device.platform}</p>
      <time dateTime={device.createdAt}>
        {device.platform === "web" ? "Added" : "Paired"} {device.createdAt}
      </time>
      {revoked ? (
        <p>Revoked</p>
      ) : (
        <button onClick={() => onRevoke(device)} type="button">
          Revoke {device.deviceName}
        </button>
      )}
    </article>
  );
}

function RevokeConfirmation({
  device,
  onCancel,
  onConfirm,
}: {
  readonly device: Device;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div aria-labelledby="revoke-title" aria-modal="true" className="panel" role="alertdialog">
      <h2 id="revoke-title">Stop {device.deviceName} from sending work to Czar?</h2>
      <button onClick={onCancel} type="button">
        Cancel
      </button>
      <button onClick={onConfirm} type="button">
        Confirm revoke
      </button>
    </div>
  );
}
