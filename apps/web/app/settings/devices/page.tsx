"use client";

import { useCallback, useEffect, useState } from "react";
import type { Device, PairingCode } from "@czar/schemas";
import { appApi } from "#src/app-api";
import { useAppData } from "#src/use-app-data";

export default function DevicesPage() {
  const [cursor, setCursor] = useState<string>();
  const [devices, setDevices] = useState<readonly Device[]>([]);
  const [pairingCode, setPairingCode] = useState<PairingCode>();
  const [revokeTarget, setRevokeTarget] = useState<Device>();
  const [actionError, setActionError] = useState<string>();
  const load = useCallback(() => appApi.listDevices(cursor), [cursor]);
  const { data, error, loading, refresh } = useAppData(load);

  useEffect(() => {
    if (!data) return;
    setDevices((current) => (cursor ? [...current, ...data.items] : data.items));
  }, [cursor, data]);

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
      setCursor(undefined);
      setPairingCode(undefined);
      refresh();
    } catch {
      setActionError("Czar could not revoke this device. Try again.");
    }
  }

  function loadMore() {
    if (data?.nextCursor) setCursor(data.nextCursor);
  }

  function reloadDevices() {
    setDevices([]);
    setCursor(undefined);
    refresh();
  }

  return (
    <section className="page-stack">
      <h1 className="czar-title">Devices</h1>
      <p>Pair your computer to let it send work to Czar. You can revoke a device at any time.</p>
      <button className="primary-link" onClick={issueCode} type="button">
        Pair a computer
      </button>
      {pairingCode && <PairingCodePanel pairingCode={pairingCode} />}
      {(error || actionError) && (
        <div className="error-panel" role="alert">
          <p>{actionError ?? error}</p>
          {error && (
            <button onClick={refresh} type="button">
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
      {!loading && devices.length === 0 && data && <p>No paired devices yet.</p>}
      {data?.nextCursor && (
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
      <h3>{device.deviceName}</h3>
      <p>{device.platform}</p>
      <time dateTime={device.createdAt}>Paired {device.createdAt}</time>
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
