# Puppy Stardew Server Addons

> [官方项目](https://github.com/AmigaMeow/puppy-stardew-server) 的外挂模块，跑完官方后再部署本模块。

## 功能

- **🖥️ noVNC 浏览器远程桌面** — 无需 VNC 客户端，浏览器直接操作游戏
- **🏠 快捷跳转面板** — 密码保护，集中管理面板 + VNC 入口
- **☁️ 备份自动同步** — 监听 `data/backups/`，新备份实时推送 S3 / WebDAV，保留最新 20 份

## 一行命令部署

```bash
curl -sSL https://raw.githubusercontent.com/llleeeqi/puppy-stardew-server-addons/main/quick-start.sh | bash
```

脚本会：
1. 检查官方容器是否运行
2. 询问登录密码、VNC 密码、服务器 IP
3. 下载配置、生成 `.env`
4. 启动外挂容器

## 手动部署

```bash
# 1. 先部署官方项目（如果用了一键脚本则跳过）
curl -sSL https://raw.githubusercontent.com/AmigaMeow/puppy-stardew-server/main/quick-start.sh | bash

# 2. 部署外挂模块
git clone https://github.com/llleeeqi/puppy-stardew-server-addons.git
cd puppy-stardew-server-addons
cp .env.example .env    # 编辑密码和服务器 IP
docker compose up -d
```

## 访问入口

| 地址 | 用途 |
|---|---|
| `http://服务器IP:53000` | 快捷跳转面板（配置密码后访问） |
| `http://服务器IP:43000` | noVNC 远程桌面 |
| `http://服务器IP:18642` | 官方管理面板 |

## 配置备份同步

访问 `http://服务器IP:53000` → 输入密码 → 点击 **☁️ 备份同步** → 展开表单配置 S3 或 WebDAV 目标。

## 迁移到新服务器

```bash
# 打包
tar czf stardew-migrate.tar.gz \
  -C /root/puppy-stardew-server data/

# 新服务器
tar xzf stardew-migrate.tar.gz -C /root/puppy-stardew-server/
# 部署官方项目 → 部署外挂模块
```
