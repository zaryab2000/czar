# Local stack

With `process-compose` available, start the local stack from the repository root with:

```sh
process-compose -f ops/local/process-compose.yaml up
```

The local T-105 signer keychain entries and `deployments/local-keys.json` must already be
provisioned through the approved local workflow. `deployments/local-keys.example.json` contains
address and key-reference placeholders only. The generated `deployments/local-keys.json` is
ignored by Git; never pass the example file to the deploy script. Deployment funds only the local
relayer from an unlocked Arc Anvil account. This start command does not provision keys.

The merchant process waits for Postgres, the server, the signer, and Circle stand-ins. Server
health follows successful database migrations. Before merchants start, the one-shot
`merchant-k10-ready` process resolves the `cz-20` / `K10:czar-search` public address through the
signer socket. The merchant then applies its own migration and resolves the same K10 address
before listening.
