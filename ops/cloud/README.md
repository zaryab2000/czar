# The Czar cloud machine (public alpha)

Everything in this folder is **code only**. Nothing here has been run against Google Cloud, and
nothing here runs against Google Cloud until Zaryab runs `create.sh --apply`. Creating the
project, the VM, the firewall, the key rings, the secrets and the bucket is his approval item;
`create.sh` defaults to `--dry-run`, which prints the command list and executes nothing at all.

The shape is SCR-170 §1–§5: **one** Google Compute Engine VM, every Czar process on loopback,
Caddy on the host as the only public listener, and every credential a file on a tmpfs.

## What each file is

| File | What it does |
|---|---|
| `provision/create.sh` | Builds the whole `gcloud` command list — APIs, service account, key rings and their IAM, the credential secrets (empty), the backup bucket, the firewall, the VM. `--dry-run` is the default and prints the list to stdout; `--apply` runs it. Project id, domain, zone and bucket are flags, never hard-coded. |
| `provision/cloud-init.yaml` | The machine's image, passed as the `user-data` metadata key: Docker, Caddy and the Ops Agent (each pinned), the two service users and the signer-client group, the credential tmpfs, the signer socket folder, and this folder's systemd units. |
| `provision/backup-lifecycle.json` | The backup bucket's lifecycle rule: delete objects after `deploy.backupRetentionDays` (14). |
| `systemd/czar-metadata-guard.service` + `systemd/metadata-guard.sh` | **Load-bearing.** Blocks the GCE metadata server for every UID but root and the signer, before Docker can start. |
| `systemd/czar-secrets.service` + `systemd/fetch-secrets.sh` | At boot, writes each credential named in `secrets.list` to `/run/czar/secrets/<service>/<file>`, mode 0400, owned by the container UID that reads it. |
| `systemd/secrets.list` | **Names only.** Which Secret Manager secret goes where, under which UID, and whether the boot may continue without it. |
| `systemd/run-czar-secrets.mount` | The dedicated `tmpfs` for `deploy.credentialFilesDir`: `nosuid,nodev,noexec`. |
| `systemd/caddy.service.d/czar-env.conf` | Hands Caddy `CZAR_DOMAIN` from `/etc/czar/caddy.env`. A pointer, not a credential. |
| `caddy/Caddyfile` | The public front door: `app.<domain>` and `merchants.<domain>`, automatic HTTPS, security headers, body caps. |
| `verify-deployment.ts` | PM-010. Read-only: builds the contracts with the `deploy` profile and the recorded library links, then compares the code at every address in `deployments/arc-testnet.json` with that build (immutables masked). Prints `match`, `mismatch` or `no-code` per contract; exits non-zero unless all match. Sends only `eth_chainId` and `eth_getCode`. |
| `test/` | The test files, run with `node --test --experimental-strip-types`. |

## Run order

1. **Review.** `ops/cloud/provision/create.sh --project <id> --domain <domain>` prints 32
   commands and runs nothing. `ops/cloud/test/golden/create-dry-run.txt` is that list, so a
   change to it shows up as a diff in review.
2. **Confirm the pinned versions** (below). None of them could be checked when this was written.
3. **Zaryab approves, then applies.** `… --project <id> --domain <domain> --apply`.
4. **Check the boot.** `cloud-init` does **not** abort `runcmd` on a failed step, so a step that
   failed is only visible in the log. On the VM, after the reboot at the end of `cloud-init`:

   ```sh
   cloud-init status --long          # must say status: done
   sudo journalctl -u cloud-final --no-pager | grep -iE 'error|failed'
   systemctl is-active czar-metadata-guard.service run-czar-secrets.mount caddy.service
   # All three guard rules must be present, and the reject must be the last of them.
   sudo iptables -C OUTPUT -d 169.254.169.254 -m owner --uid-owner 0 -j ACCEPT &&
     sudo iptables -C OUTPUT -d 169.254.169.254 -m owner --uid-owner 10002 -j ACCEPT &&
     sudo iptables -C OUTPUT -d 169.254.169.254 -j REJECT &&
     echo "guard in place"
   sudo iptables -L OUTPUT -n --line-numbers | grep 169.254.169.254   # reject must be last
   sudo systemd-analyze verify czar-metadata-guard.service czar-secrets.service
   ```

5. **Point DNS** `app.<domain>` and `merchants.<domain>` at the VM's address. Caddy cannot get
   a certificate before this, and will keep retrying until it can.
6. **Add the Secret Manager versions.** `create.sh` creates every secret **empty**; putting a
   value in one is Zaryab's step and never this script's. Then, on the VM:
   `sudo systemctl start czar-secrets.service`.
   The nightly backup (PM-052, PM-052b) is installed by cloud-init: the PostgreSQL 16 client, the
   scripts under `/opt/czar/ops/backup`, `/etc/czar/backup.env` (the bucket name) and
   `czar-backup.timer`, enabled for the next boot. The timer fires at 02:30 UTC and needs the
   `backup/db-password` file from this step.
7. **Images and compose are PM-013 and PM-014.** Until they land, Caddy answers 502: it is
   enabled with nothing behind it. That is the intended end state of PM-011/PM-012.

## Confirm before `--apply`

The sandbox this was written in has no route to any vendor package index, so **not one of these
version strings could be verified.** They are the reviewed intent. Check each against its index
and correct `cloud-init.yaml` before applying; the tests enforce only that every third-party
package is pinned and held, not which version it is pinned to.

| Package | Pinned to | Where to check |
|---|---|---|
| `docker-ce`, `docker-ce-cli` | `5:27.5.1-1~debian.12~bookworm` | `https://download.docker.com/linux/debian/dists/bookworm/stable/binary-amd64/` |
| `containerd.io` | `1.7.25-1` | the same index |
| `docker-compose-plugin` | `2.32.4-1~debian.12~bookworm` | the same index |
| `caddy` | `2.10.0` | `https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt` |
| `google-cloud-ops-agent` | `2.53.0~debian12` | `https://packages.cloud.google.com/apt/dists/google-cloud-ops-agent-bookworm-2/` |

Also confirm, on the first boot, that the Debian 12 image on GCE runs `cloud-init` from the
`user-data` metadata key. If it does not, the same `runcmd` steps work as a `startup-script`.

## The metadata-server guard

Every Czar container runs with `network_mode: host` (SCR-170 §1), so each one shares the host's
network stack. Without a rule, any container could fetch a service-account token from
`169.254.169.254` and call Cloud KMS `asymmetricSign` on K3, K7, K8 or K10 **directly**,
skipping every policy the signer enforces, or read every credential out of Secret Manager.

So `czar-metadata-guard.service` runs before `docker.service` at every boot and applies:

```
iptables -A OUTPUT -d 169.254.169.254 -m owner --uid-owner 0     -j ACCEPT
iptables -A OUTPUT -d 169.254.169.254 -m owner --uid-owner 10002 -j ACCEPT
iptables -A OUTPUT -d 169.254.169.254                            -j REJECT
```

plus the `ip6tables` equivalents for `fd00:ec2::254` when IPv6 is on. Root keeps access because
`czar-secrets.service`, the backup timer and the Ops Agent need it. The signer (UID 10002) keeps
it because signing is its job. Nothing else does.

**Why three rules and not the one SCR-170 §4 writes.** The spec gives the guard as a single
negated rule, `-m owner ! --uid-owner 0 ! --uid-owner 10002 -j REJECT`. **iptables refuses it**:
one `-m owner` match takes `--uid-owner` only once.

```
$ iptables -C OUTPUT -d 169.254.169.254 -m owner ! --uid-owner 0 ! --uid-owner 10002 -j REJECT
iptables v1.8.10 (nf_tables): owner: option "--uid-owner" can only be used once.   # exit 2
```

Exit 2 is a parse error; a valid-but-absent rule exits 1 with `Bad rule`. The three rules above
are semantically identical and do parse. See the spec-change request in the PR body.

**Order is load-bearing.** The `REJECT` must be last. Appended first it would shadow both
`ACCEPT`s and lock root and the signer out of the metadata server, breaking
`czar-secrets.service`, the backups, the Ops Agent and all signing. The guard therefore never
appends into a partial state: if any of the three is missing it removes whichever are present
and appends all three in order. It is idempotent — it asks `iptables` with `-C` first — and a
`-C` exit other than 0 or 1 ends the script, so a rule iptables will not accept can never again
be mistaken for a missing one.

**Do not weaken this for convenience.** `ops/cloud/test/metadata-guard.test.ts` fails if a third
UID is ever named, if the reject stops being last or becomes conditional, if a failure is
swallowed, or — via `iptables-translate`, which parses a rule without touching the host
firewall — if any rule the guard builds is one iptables would reject.

## Credentials

Credentials are **files**, never environment variables, command-line arguments, image layers,
compose files or config values (SCR-170 §4, D70, D78).

- They live under `deploy.credentialFilesDir` (`/run/czar/secrets`), on a `tmpfs`, so none of
  them survives a reboot and none is ever on the persistent disk.
- Each is mode `0400`, owned by the one container UID that reads it. Each service folder is
  `0500`, so no other UID can even list it.
- `fetch-secrets.sh` gets a short-lived access token from `deploy.metadataTokenUrl`, hands it to
  `curl` through a 0600 header file so it never appears in `ps`, and never prints a value.
  Its stdout is empty by design; it logs names only, to stderr.
- A secret marked `required` in `secrets.list` that has no version **fails the boot**. A `403`
  or any other non-404 answer also fails it: a misconfiguration is never read as
  "not configured".
- `czar-alpha-anthropic-api-key` is the one `optional` row, because `models.provider` defaults
  to `none` and connecting a provider needs Zaryab's approval (SCR-170 §6).

## The public surface

Caddy is the only listener on 80 and 443. Everything else binds `127.0.0.1`.

| Origin | Path | Upstream |
|---|---|---|
| `app.<domain>` | `POST /v1/jobs/<key>/deliverable` | server `127.0.0.1:3000`, body cap 20 MiB (`acceptance.deliverableMaxBytes`) |
| `app.<domain>` | `/v1/*` | server `127.0.0.1:3000`, body cap 1 MiB |
| `app.<domain>` | `/health` | server `127.0.0.1:3000` |
| `app.<domain>` | everything else | web app `127.0.0.1:3100` |
| `merchants.<domain>` | everything | merchants `127.0.0.1:8787` |

The deliverable route is matched **before** the general `/v1/*` cap, or a 1 MiB cap would reject
uploads the server would have accepted (GC-9a). There is no `api.` subdomain on purpose: one app
origin keeps the passkey RP ID, the cookies and `daemon.serverOrigin` on one host (SCR-170 §2).

The Caddy admin API is **off**. It would otherwise listen on `127.0.0.1:2019`, which every
host-network container can reach — the same exposure the metadata guard exists to close.

No `email` is set, so Caddy registers an ACME account without one: an unset placeholder is a
Caddyfile parse error, and a made-up default would register a fake address with Let's Encrypt.
To get expiry notices, add one real `email <address>` line to the global block and reload.

## Tests

```sh
# The glob, not the folder: `node --test <folder>` resolves it as a module on Node 22.
node --test --experimental-strip-types ops/cloud/test/*.test.ts

shellcheck ops/cloud/**/*.sh

CZAR_DOMAIN=example.com caddy validate --config ops/cloud/caddy/Caddyfile --adapter caddyfile
```

The third command needs a `caddy` binary of the pinned version. Where Docker Hub is reachable:

```sh
docker run --rm -e CZAR_DOMAIN=example.com -v "$PWD/ops/cloud/caddy:/etc/caddy:ro" \
  caddy:2.10.0 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

`test/verify-deployment.test.ts` deploys to a local pinned `arc-anvil --network arc`, so it needs
Arc Foundry (`scripts/install-arc-foundry.sh`) on `PATH`, or `ARC_ANVIL` and `ARC_FORGE` set, and
the contract submodules checked out (`git submodule update --init contracts/lib/forge-std
contracts/lib/openzeppelin-contracts`). It writes its Foundry broadcast record to a scratch
folder, never to `contracts/broadcast/`, where the real testnet record lives on the machine that
deployed.

## Checking the testnet deployment

From the repository root, on a machine that can reach Arc testnet, with Arc Foundry on `PATH`:

```sh
node --experimental-strip-types ops/cloud/verify-deployment.ts --rpc-url https://rpc.testnet.arc.io
```

A deployment that matches this checkout prints ten lines ending in `match`, then
`10 of 10 contracts match`, and exits 0. Any `mismatch` or `no-code` means testnet does not run
this checkout's code at that address; the exit code is then 1.

## Not here

- Running `--apply`, or anything else against Google Cloud.
- Container images (PM-013) and the cloud compose file (PM-014).
- Monitoring and alerts (PM-051), which configure the Ops Agent this installs.
- Key creation (PM-018). `create.sh` creates the two key rings and no key.
