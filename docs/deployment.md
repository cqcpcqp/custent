# 单机受限测试部署

本方案面向 `118.25.99.69`（Ubuntu / amd64）。GitHub Actions 构建镜像并发布到 GHCR，再通过 SSH 部署到 `/opt/custent`。现有 `underelay-site` 的 `8080` 端口不变。

## 访问与安全边界

- 测试入口：`http://118.25.99.69:8081`。Nginx 只接受 `223.166.95.113` 和本机 `127.0.0.1`；其他 IPv4 来源返回 403，不监听 IPv6。修改白名单必须修改 `deploy/nginx.conf` 并重新部署。
- Nginx 使用宿主机网络，不依赖 Docker 端口转发后的来源地址；不信任请求提供的 `X-Forwarded-For`。Web 只映射到 `127.0.0.1:3000`，数据库不发布端口。
- 云安全组应额外将 TCP 8081 的来源限制为 `223.166.95.113/32`。服务器没有云账号权限时，必须由管理员在云控制台配置。应用层白名单不能替代云防火墙，也不能保护 SSH。
- 此入口没有 TLS，项目仍是固定 Demo 用户。仅供受限测试，不要传输密码、个人资料或敏感附件。需要加密时使用 `ssh -L 8081:127.0.0.1:8081 ubuntu@118.25.99.69`，访问本机 `http://127.0.0.1:8081`。
- 不修改现有 SSH 登录方式、不关闭已有 8080 服务、不启用可能影响现有服务的全局 UFW 规则。安装专用部署公钥时使用 `restrict` 禁止端口转发和 PTY；该密钥仍能以部署用户运行命令，且该用户具有 sudo 权限，必须作为高权限部署凭据保护。

## 首次初始化

1. 在安全临时目录准备 `app.env`、`db.env`，权限均为 600。不要放入 Git。
2. `app.env` 使用 `.env.example` 中真实的供应商和计费配置，将 `DATABASE_URL` 设置为 `postgres://custent:<随机密码>@db:5432/custent`。不要使用开发数据库密码，不要携带本机路径的 `PDF_FONT_PATH`。无需设置 `NODE_ENV`，镜像已固定为 production；不要设置任何包含秘密的 `NEXT_PUBLIC_*` 变量。
3. `db.env` 包含 `POSTGRES_USER=custent`、`POSTGRES_DB=custent`、`POSTGRES_PASSWORD=<同一随机密码>`。生产 `DEMO_USER_ID` 必须匹配迁移创建的演示用户；新数据库不会自动复制本地业务数据。
4. 将文件通过 SSH 传到服务器，运行 `sudo bash deploy/bootstrap.sh /安全临时目录/app.env /安全临时目录/db.env`。初始化拒绝覆盖已有部署密钥文件。确认安装成功后删除临时副本。
5. 把专用 SSH 公钥追加到部署用户的 `authorized_keys`，核验服务器 host key，不要在 CI 中用 `ssh-keyscan` 自动信任未知主机。

持久化文件：

| 路径 | 用途 |
| --- | --- |
| `/opt/custent/shared/app.env` | 应用配置、供应商密钥，root/600 |
| `/opt/custent/shared/db.env` | 数据库配置，root/600 |
| `/opt/custent/shared/postgres` | PostgreSQL 数据 |
| `/opt/custent/shared/artifacts` | 生成文件，容器 UID 1000 可写 |
| `/opt/custent/shared/input-attachments` | 输入附件，容器 UID 1000 可写 |
| `/opt/custent/shared/maintenance/enabled` | 存在时入口返回 503 |
| `/opt/custent/backups` | 发布前数据库、文件、环境配置备份，root/700 |
| `/opt/custent/current` | 最近成功发布的配置目录 |
| `/opt/custent/current-image` | 最近成功发布的镜像 digest |

## GitHub Environment

在仓库创建 `production` Environment，配置以下变量与 Secrets：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Variable | `DEPLOY_HOST` | `118.25.99.69` |
| Variable | `DEPLOY_USER` | `ubuntu` |
| Variable | `DEPLOY_PORT` | `22` |
| Secret | `DEPLOY_SSH_KEY` | 专用部署私钥 |
| Secret | `DEPLOY_KNOWN_HOSTS` | 已核验的服务器 known_hosts 记录 |

将 Environment 的部署分支限制为 `main`，按仓库套餐能力配置审批。第三方 Actions 固定到查询得到的提交 SHA。

- PR 只运行非浏览器检查，不获取部署 Secrets、不发布镜像。
- `main` push 或 `main` 上的手动触发运行检查、发布、部署。检查使用一次性 PostgreSQL，运行全部数据库集成测试，不调用真实供应商、不运行浏览器测试。
- 发布使用 `GITHUB_TOKEN` 的 `packages: write`。部署使用当前 job 的 `packages: read` token，通过 SSH 标准输入传到 `docker login --password-stdin`。服务器只保存临时 Docker 登录配置，结束时清理；不需要长期 GHCR PAT。
- 镜像带 commit SHA 标签，部署实际使用 digest。过时提交跳过部署，同一生产环境串行执行，不自动取消正在进行的迁移。
- 若服务器到 GHCR 的链路持续失败，可在受信任机器拉取同一 digest，通过 SSH 执行 `docker save` / `docker load` 中转，再以 `CUSTENT_PRELOADED_IMAGE=sha256:<digest>` 调用部署脚本。脚本要求预载 image ID 与请求 digest 完全相同，并跳过 registry 登录和拉取；这不是接受可变 tag 的回退。
- 不会从开发机自动上传 API Key 到 GitHub；供应商配置仅保存在服务器。服务器需要能访问 GHCR 和已配置的模型供应商。

## 发布与故障处理

发布会先拉取镜像和校验配置，然后打开维护开关、停止 Web 接收写入，等待 `queued/running` Run 排空（最多 10 分钟）。超时保留旧 Worker 运行，不强杀模型请求、不迁移。随后停止旧后台进程、备份数据库和文件、运行迁移、统一启动新版进程。后台进程启动后检查运行状态和重启次数，Web 使用真实 `/api/bootstrap` 验证数据库和应用配置。

数据库服务使用 `--no-recreate` 保持已有进程，PostgreSQL 升级需另外安排维护；不要在应用发布时隐式升级数据库。

失败时保持维护状态，不自动回滚已经迁移的数据库。先查看 Actions 日志以及失败 release 的 Compose 日志；不要直接删除维护文件。修复配置后重新运行 workflow。恢复必须同时考虑数据库、附件、生成文件与应用版本；不要直接恢复旧镜像并假定 schema 兼容。

首次发布会建立空业务数据库及项目迁移定义的演示账户，不迁移本机数据。发布流程不产生付费模型调用；功能验证的真实研究需用户主动发起。

本机 2GB 内存先将 Worker 并发设为 1；不能据此保证稳定负载。镜像保留 Worker/迁移所需的 TS 源码和 `tsx` 依赖，不使用缺少后台脚本的 standalone-only 镜像。后续根据运行指标决定内存扩容。日志限制每容器 3×10MB；备份与旧镜像暂不自动删除，需定期检查磁盘并将备份另存到服务器之外。

## 非浏览器验证

```bash
curl -f http://118.25.99.69:8081/api/bootstrap
```

在允许的出口执行上面的请求应返回 200。服务器本机从 `127.0.0.2` 请求代理应返回 403，即使伪造 `X-Forwarded-For: 223.166.95.113` 也不能绕过；维护模式应返回 503。检查容器状态、日志、端口绑定、数据库迁移记录，并确认原有 8080 服务仍正常。不打开浏览器。
