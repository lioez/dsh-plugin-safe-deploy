# dsh-plugin-safe-deploy

A generic, preflight-gated Cloudflare deploy plugin for DeepSeek Harness (dsh).

It splits deployment into **preflight → review → confirm → deploy**. The first call only inspects the target directory and returns a file inventory, hard blockers (keys, certs, secrets, symlinks), review items (server/scripts/source), Cloudflare/PWA adaptation checks, and a directory fingerprint. A real deploy requires the same fingerprint via `confirm`, then goes through the existing dsh approval flow.

Derived from [Octo-o-o-o/dsh-plugin-deploy](https://github.com/Octo-o-o-o/dsh-plugin-deploy) (MIT); upstream deploy/credentials/approval design retained. Repository: [lioez/dsh-plugin-safe-deploy](https://github.com/lioez/dsh-plugin-safe-deploy).

## Install

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-plugin-safe-deploy
# remove the old dsh-plugin-deploy first if installed, to avoid a duplicate deploy tool
```

Requires Node.js 22+; actual deployment needs `wrangler` on PATH (>= 4.102 for temporary preview) and a Cloudflare account/token for `account` mode.

## Preflight report

The first `deploy` call without `confirm` returns:

- project kind and assets root;
- file count, total size, top-level layout;
- blocked files (private keys, cert directories, env files, symlinks, limits);
- review files (server/scripts/source/tests/package metadata);
- static-host and PWA checks (index, manifest, icons, sw.js);
- local-only API/private-network references;
- a short fingerprint. If the directory changes before confirmation, the deploy is rejected.

## Cloudflare adaptation

This plugin targets **Workers static assets** (not Pages). DNS, custom domains and preferred-domain routing are project-side configuration (e.g. `wrangler.jsonc` routes). Temporary previews use Cloudflare claim deployments and expire after 60 minutes unless claimed. Credentials are read from dsh credentials and never enter the model context or tool arguments.

## Attribution & License

MIT. Based on [Octo-o-o-o/dsh-plugin-deploy](https://github.com/Octo-o-o-o/dsh-plugin-deploy); original copyright and license retained.