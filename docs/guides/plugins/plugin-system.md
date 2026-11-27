# Plugin System

> SemVer 2.0.0 compatibility engine, topological dependency DAG, conflict detection, and frozen capability-scoped PluginContext.

- **Section**: Plugins & Extensions
- **Packages**: @forge-fr/core
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/plugins/plugin-system
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/plugins/plugin-system.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Declared capabilities & frozen PluginContext

Every ForgeJS plugin explicitly declares the capabilities it requires. During kernel boot, createPluginContext() creates a frozen context object whose methods enforce capability boundaries at runtime.

| Capability | Permitted PluginContext Operation |
| --- | --- |
| di:register | Register private or explicitly exported providers into the container |
| di:resolve | Resolve visible providers registered by core or declared plugin dependencies |
| config:read | Read kernel configuration values via ConfigManager |
| events:emit | Emit typed kernel events |
| events:listen | Subscribe to kernel lifecycle or domain events |
| hooks:register | Attach handlers to kernel lifecycle hooks |
| health:register | Register readiness/liveness checks with HealthRegistry |

## SemVer compatibility, dependencies & conflicts

- forgeVersion ranges are checked against FORGE_CORE_VERSION using the built-in SemVer 2.0.0 engine before any plugin hook runs.
- Plugin dependencies are topologically sorted at boot and shut down in exact reverse order.
- Calling a PluginContext API outside declared capabilities throws PluginCapabilityError immediately.
- Conflicting plugins or circular plugin dependencies fail fast with PluginConflictError or CircularPluginDependencyError.
