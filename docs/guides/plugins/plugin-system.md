# Plugin System

> How ForgeJS plugins check version compatibility, boot in dependency order, detect conflicts, and run with scoped permissions.

- **Section**: Plugins & Extensions
- **Packages**: @forge-fr/core
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/plugins/plugin-system
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/plugins/plugin-system.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Declared permissions & locked PluginContext

Every plugin lists the exact capabilities it needs. At startup, ForgeJS hands the plugin a locked context object that only lets it call the APIs it declared.

| Capability | What the Plugin Is Allowed to Do |
| --- | --- |
| di:register | Register private or exported services into the DI container |
| di:resolve | Read exported services from core or declared plugin dependencies |
| config:read | Read settings from ConfigManager |
| events:emit | Send typed kernel events |
| events:listen | Listen to kernel lifecycle or app events |
| hooks:register | Attach callbacks to kernel lifecycle hooks |
| health:register | Add liveness or readiness checks to HealthRegistry |

## Version checks, boot order & conflict protection

- forgeVersion ranges are checked against the running @forge-fr/core version before any plugin runs.
- Plugins start in dependency order and shut down in exact reverse order.
- If a plugin calls an API it did not declare, ForgeJS stops immediately with PluginCapabilityError.
- Conflicting plugins or circular dependencies fail fast at startup with clear error messages.
