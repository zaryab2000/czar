# czar

The Czar background app: a local daemon and the `czar` command.

## Install

Requires Node.js 22.18 or later in the 22 line, on macOS or Linux.

```sh
npm install -g <package-name>
czar --version
czar status
```

## Commands

- `czar status`: show whether the background app is installed and running
- `czar install`: install and start the background app
- `czar update`: update the installed background app
- `czar uninstall [--delete-memory]`: remove the background app
- `czar pair <code>`, `czar objective <goal>`, `czar result <objectiveId>`: macOS only
- `czar daemon`: run the daemon in the foreground (used by the service)
- `czar config dump`: print the effective configuration

Keys and secrets stay in the operating system keychain; this package holds none.
