#!/usr/bin/env bash
# Czar public alpha: create the cloud machine, its firewall, its key rings and its backup
# bucket (SCR-170 §1, §4, §5).
#
# NOTHING HAPPENS WITHOUT --apply. The default is --dry-run, which prints the command list to
# stdout and runs nothing at all — not one read, not one write. Creating the project, the VM,
# the keys and the buckets is Zaryab's approval item; this script exists so that the whole set
# of commands can be reviewed as code first.
#
#   review:  ops/cloud/provision/create.sh --project <id> --domain <domain>
#   create:  ops/cloud/provision/create.sh --project <id> --domain <domain> --apply
#
# The project id, the domain, the zone and the bucket name are flags. None of them is
# hard-coded, and no credential of any kind appears in this file or in anything it prints.
# Secret Manager secrets are created EMPTY here: adding a version is Zaryab's step (D70, D78).
set -euo pipefail

readonly INSTANCE_NAME="czar-alpha"
readonly SERVICE_ACCOUNT_NAME="czar-alpha-vm" # SCR-170 §4: the VM's one service account
readonly KEY_RING="czar-alpha"               # long-lived keys K3, K5, K7, K8, K10, K21, relayer
readonly POCKET_KEY_RING="czar-alpha-pockets" # runtime K4 pocket keys
readonly MACHINE_TYPE="e2-medium"            # 2 vCPU, 4 GB (SCR-170 §1)
readonly BOOT_DISK_SIZE="30GB"               # SCR-170 §1
readonly BOOT_DISK_TYPE="pd-balanced"        # SCR-170 §1
readonly IMAGE_FAMILY="debian-12"
readonly IMAGE_PROJECT="debian-cloud"
readonly DEFAULT_ZONE="asia-south1-a" # SCR-170 §1; overridable with --zone
readonly NETWORK="default"
readonly NETWORK_TAG="czar-alpha"
readonly IAP_SSH_RANGE="35.235.240.0/20" # SCR-170 §1: the only source that may reach 22
readonly ANY_SOURCE="0.0.0.0/0"
readonly ALLOW_PRIORITY=1000
readonly DENY_PRIORITY=65000 # below the allows, above the default network's own rules

project=""
domain=""
zone="$DEFAULT_ZONE"
bucket=""
apply="no"

usage() {
  cat <<'USAGE'
Usage: create.sh --project <id> --domain <domain> [--zone <zone>] [--bucket <name>] [--apply]

  --project <id>    the Google Cloud project (required)
  --domain <domain> the public domain; app.<domain> and merchants.<domain> are served (required)
  --zone <zone>     default asia-south1-a; the region is derived from it
  --bucket <name>   default czar-alpha-backups-<project>
  --dry-run         print the command list and run nothing (the default)
  --apply           run the commands; needs Zaryab's approval first
USAGE
}

fail() {
  printf 'create.sh: %s\n' "$1" >&2
  usage >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      project="${2:-}"
      shift 2 || fail "--project needs a value"
      ;;
    --domain)
      domain="${2:-}"
      shift 2 || fail "--domain needs a value"
      ;;
    --zone)
      zone="${2:-}"
      shift 2 || fail "--zone needs a value"
      ;;
    --bucket)
      bucket="${2:-}"
      shift 2 || fail "--bucket needs a value"
      ;;
    --dry-run)
      apply="no"
      shift
      ;;
    --apply)
      apply="yes"
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

# Every flag is validated before it is ever put in a command, so the command list below can be
# split on whitespace and run as argv with no shell expansion anywhere.
[[ -n "$project" ]] || fail "--project is required"
[[ -n "$domain" ]] || fail "--domain is required"
# Shape only. Google enforces its own 6-to-30-character rule and rejects an id it does not own;
# what matters here is that nothing shell-expandable reaches a command.
[[ "$project" =~ ^[a-z][a-z0-9-]*$ ]] || fail "--project is not a project id"
[[ ${#project} -le 30 ]] || fail "--project is too long for a project id"
[[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
  fail "--domain is not a domain name"
[[ "$zone" =~ ^[a-z]+-[a-z]+[0-9]+-[a-z]$ ]] || fail "--zone is not a zone"
bucket="${bucket:-czar-alpha-backups-$project}"
[[ "$bucket" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] || fail "--bucket is not a bucket name"

# asia-south1-a -> asia-south1
region="${zone%-*}"
service_account="$SERVICE_ACCOUNT_NAME@$project.iam.gserviceaccount.com"
member="serviceAccount:$service_account"

# Paths are printed relative to the repository root, so the printed list is the same on every
# machine and can be diffed in review.
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly CLOUD_INIT="ops/cloud/provision/cloud-init.yaml"
readonly LIFECYCLE_FILE="ops/cloud/provision/backup-lifecycle.json"
readonly SECRETS_LIST="ops/cloud/systemd/secrets.list"
readonly GUARD_SCRIPT="ops/cloud/systemd/metadata-guard.sh"
readonly GUARD_UNIT="ops/cloud/systemd/czar-metadata-guard.service"
readonly SECRETS_SCRIPT="ops/cloud/systemd/fetch-secrets.sh"
readonly SECRETS_UNIT="ops/cloud/systemd/czar-secrets.service"
readonly SECRETS_MOUNT="ops/cloud/systemd/run-czar-secrets.mount"
readonly CADDYFILE="ops/cloud/caddy/Caddyfile"
readonly CADDY_DROPIN="ops/cloud/systemd/caddy.service.d/czar-env.conf"
readonly BACKUP_SCRIPT="ops/cloud/backup/pg-backup.sh"
readonly BACKUP_LIB="ops/cloud/backup/lib.sh"
readonly RESTORE_DRILL="ops/cloud/backup/pg-restore-drill.sh"
readonly BACKUP_UNIT="ops/cloud/backup/czar-backup.service"
readonly BACKUP_TIMER="ops/cloud/backup/czar-backup.timer"

# The command list, and a parallel list saying whether a non-zero exit is acceptable. Only the
# two deletes of the default network's permissive rules are: a fresh project may not have them.
commands=()
tolerant=()

add() {
  commands+=("$1")
  tolerant+=("no")
}

add_tolerant() {
  commands+=("$1")
  tolerant+=("yes")
}

# ---- the secret names, read from the one place that holds them ------------------------------
# secrets.list holds names only. A secret may appear on two rows (one value, two destinations),
# so the names are de-duplicated while keeping the file's order.
secret_names=()
read_secret_names() {
  local raw line name
  local -a fields
  local -A seen=()
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    line="${raw%%#*}"
    fields=()
    read -r -a fields <<<"$line"
    [[ ${#fields[@]} -eq 0 ]] && continue
    name="${fields[0]}"
    [[ "$name" =~ ^czar-alpha-[a-z0-9-]+$ ]] || fail "bad secret name in $SECRETS_LIST: $name"
    [[ -n "${seen[$name]:-}" ]] && continue
    seen["$name"]=1
    secret_names+=("$name")
  done <"$repo_root/$SECRETS_LIST"
  [[ ${#secret_names[@]} -gt 0 ]] || fail "$SECRETS_LIST names no secret"
}

build_command_list() {
  # ---- 1. the APIs this machine needs ------------------------------------------------------
  add "gcloud services enable compute.googleapis.com cloudkms.googleapis.com secretmanager.googleapis.com storage.googleapis.com logging.googleapis.com monitoring.googleapis.com --project=$project"

  # ---- 2. the VM's one service account (SCR-170 §4) ----------------------------------------
  add "gcloud iam service-accounts create $SERVICE_ACCOUNT_NAME --project=$project --display-name=$SERVICE_ACCOUNT_NAME"

  # ---- 3. the two key rings. No KEY is created here: that is tracker PM-018 ------------------
  add "gcloud kms keyrings create $KEY_RING --project=$project --location=$region"
  add "gcloud kms keyrings create $POCKET_KEY_RING --project=$project --location=$region"

  # ---- 4. key-ring roles, each scoped to one ring (SCR-170 §4) ------------------------------
  # Signing and reading on the long-lived ring; nothing more, so a token cannot create a key.
  add "gcloud kms keyrings add-iam-policy-binding $KEY_RING --project=$project --location=$region --member=$member --role=roles/cloudkms.signerVerifier"
  add "gcloud kms keyrings add-iam-policy-binding $KEY_RING --project=$project --location=$region --member=$member --role=roles/cloudkms.viewer"
  # Admin on the pocket ring only, because K4 pocket keys are created and destroyed at runtime.
  add "gcloud kms keyrings add-iam-policy-binding $POCKET_KEY_RING --project=$project --location=$region --member=$member --role=roles/cloudkms.admin"

  # ---- 5. the credential secrets, created empty, each bound on its own ----------------------
  local name
  for name in "${secret_names[@]}"; do
    add "gcloud secrets create $name --project=$project --replication-policy=automatic"
  done
  for name in "${secret_names[@]}"; do
    add "gcloud secrets add-iam-policy-binding $name --project=$project --member=$member --role=roles/secretmanager.secretAccessor"
  done

  # ---- 6. the backup bucket, private, with the SCR-170 §5 retention -------------------------
  add "gcloud storage buckets create gs://$bucket --project=$project --location=$region --uniform-bucket-level-access --public-access-prevention --default-storage-class=STANDARD"
  add "gcloud storage buckets update gs://$bucket --project=$project --lifecycle-file=$LIFECYCLE_FILE"
  add "gcloud storage buckets add-iam-policy-binding gs://$bucket --project=$project --member=$member --role=roles/storage.objectAdmin"

  # ---- 7. the firewall: 80 and 443 from anywhere, 22 from IAP only, nothing else -----------
  # The default network ships a world-open rule for 22 and one for 3389. Both go, or "22 from
  # the IAP range only" is not true.
  add_tolerant "gcloud compute firewall-rules delete default-allow-ssh --project=$project --quiet"
  add_tolerant "gcloud compute firewall-rules delete default-allow-rdp --project=$project --quiet"
  add "gcloud compute firewall-rules create czar-alpha-allow-web --project=$project --network=$NETWORK --direction=INGRESS --action=ALLOW --rules=tcp:80,tcp:443 --source-ranges=$ANY_SOURCE --target-tags=$NETWORK_TAG --priority=$ALLOW_PRIORITY"
  add "gcloud compute firewall-rules create czar-alpha-allow-iap-ssh --project=$project --network=$NETWORK --direction=INGRESS --action=ALLOW --rules=tcp:22 --source-ranges=$IAP_SSH_RANGE --target-tags=$NETWORK_TAG --priority=$ALLOW_PRIORITY"
  # Everything the two allows do not name is denied, so a later default rule cannot open a port.
  add "gcloud compute firewall-rules create czar-alpha-deny-ingress --project=$project --network=$NETWORK --direction=INGRESS --action=DENY --rules=all --source-ranges=$ANY_SOURCE --target-tags=$NETWORK_TAG --priority=$DENY_PRIORITY"

  # ---- 8. the machine ----------------------------------------------------------------------
  # --scopes=cloud-platform: with the narrower default scopes, Cloud KMS and Secret Manager
  # calls fail for insufficient scopes (SCR-170 §4). The roles above are what actually limits
  # this service account.
  #
  # Every repository file the image needs is passed as its own metadata attribute, so cloud-init
  # reads them back at boot and the private repository never has to be reachable from the VM.
  # None of them is a credential.
  add "gcloud compute instances create $INSTANCE_NAME --project=$project --zone=$zone --machine-type=$MACHINE_TYPE --image-family=$IMAGE_FAMILY --image-project=$IMAGE_PROJECT --boot-disk-size=$BOOT_DISK_SIZE --boot-disk-type=$BOOT_DISK_TYPE --boot-disk-device-name=$INSTANCE_NAME --service-account=$service_account --scopes=cloud-platform --tags=$NETWORK_TAG --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring --metadata=CZAR_DOMAIN=$domain,CZAR_BACKUP_BUCKET=$bucket --metadata-from-file=user-data=$CLOUD_INIT,czar-metadata-guard-sh=$GUARD_SCRIPT,czar-metadata-guard-service=$GUARD_UNIT,czar-fetch-secrets-sh=$SECRETS_SCRIPT,czar-secrets-service=$SECRETS_UNIT,czar-secrets-mount=$SECRETS_MOUNT,czar-secrets-list=$SECRETS_LIST,czar-caddyfile=$CADDYFILE,czar-caddy-dropin=$CADDY_DROPIN,czar-backup-sh=$BACKUP_SCRIPT,czar-backup-lib-sh=$BACKUP_LIB,czar-restore-drill-sh=$RESTORE_DRILL,czar-backup-service=$BACKUP_UNIT,czar-backup-timer=$BACKUP_TIMER"
}

print_command_list() {
  local rendered
  for rendered in "${commands[@]}"; do
    printf '%s\n' "$rendered"
  done
}

run_command_list() {
  local index rendered
  local -a argv
  for index in "${!commands[@]}"; do
    rendered="${commands[$index]}"
    printf 'create.sh: running: %s\n' "$rendered" >&2
    argv=()
    read -r -a argv <<<"$rendered"
    if "${argv[@]}"; then
      continue
    fi
    if [[ "${tolerant[$index]}" == "yes" ]]; then
      printf 'create.sh: that step was already done or not present; carrying on\n' >&2
      continue
    fi
    fail "step $((index + 1)) failed; nothing after it has run"
  done
}

main() {
  read_secret_names
  build_command_list

  if [[ "$apply" == "yes" ]]; then
    command -v gcloud >/dev/null 2>&1 || fail "gcloud is not installed"
    cd -- "$repo_root"
    printf 'create.sh: applying %d commands to project %s\n' "${#commands[@]}" "$project" >&2
    run_command_list
    printf 'create.sh: done. Add the Secret Manager versions, then: systemctl start czar-secrets.service\n' >&2
    return 0
  fi

  # Dry run. stdout is the command list and nothing else, so it diffs cleanly in review.
  print_command_list
  printf 'create.sh: dry run. %d commands printed, none run. Add --apply to run them.\n' \
    "${#commands[@]}" >&2
}

main "$@"
