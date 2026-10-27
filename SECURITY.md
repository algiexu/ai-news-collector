# Security Policy

## Supported version

安全修复优先应用在当前主分支和最新版本。

## 报告问题

请使用 GitHub 仓库的 **Security → Report a vulnerability** 私下报告：

- 凭据或个人信息泄露
- 可执行任意代码的解析问题
- 可绕过网络边界或文件边界的输入
- GitHub Actions 权限或供应链风险

不要在公开 Issue 中粘贴密钥、Cookie、代理账号或完整攻击载荷。

## 设计边界

- 本项目不会绕过验证码、登录限制或目标站点的访问控制。
- 采集结果默认写入本地 `data/`，并已通过 `.gitignore` 排除。
- 来源配置和日志在提交前应人工检查，避免带入凭据。
