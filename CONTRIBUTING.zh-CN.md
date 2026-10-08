# 贡献指南

[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md)

欢迎使用英文或中文提交 Issue 与 PR，请先阅读 [README](README.zh-CN.md) 与 [架构](docs/architecture.zh-CN.md)。

修改保持聚焦；新增生产依赖、扩大权限、新数据源或自动写操作先讨论。保留未知关系与账号隔离规则。

Bug 报告应包含版本、环境、复现步骤、预期与实际行为，使用合成示例。不上传真实关系名单、Cookie、Token、API Key 或私信。安全问题通过 [安全政策](SECURITY.zh-CN.md) 指定的私密渠道报告。

```sh
npm test
npm run check
npm run package
```

PR 说明实际检查与未验证部分。关系证据、存储与写操作需适当回归覆盖；合成测试通过不代表真实取关成功。

贡献采用 [MIT](LICENSE) 许可，不提交无授权代码、素材或用户数据。
