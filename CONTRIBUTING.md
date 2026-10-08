# Contributing

[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md)

Issues and pull requests in English or Simplified Chinese are welcome. Read the [README](README.md) and [architecture](docs/architecture.md) first.

Keep changes focused. Discuss new production dependencies, broader permissions, new data sources or automated writes before implementation. Preserve unknown relationship data and account isolation.

Bug reports should include version, environment, reproduction steps and expected/actual behavior. Use synthetic examples. Never attach real account lists, cookies, tokens, keys or private messages. Report security issues privately under [SECURITY.md](SECURITY.md).

```sh
npm test
npm run check
npm run package
```

State which checks ran and what remains unverified. Changes to relationship evidence, persistence or writes need meaningful regression coverage. Passing synthetic tests does not prove real X writes succeeded.

Contributions are licensed under [MIT](LICENSE). Do not submit code, assets or user data without permission.
