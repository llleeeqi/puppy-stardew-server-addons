# Puppy Stardew Server — Custom Addons

独立外挂模块，与官方项目分离。跑完官方 `docker compose up -d` 后运行本模块即可。

## 内容

- **noVNC** — 浏览器 VNC 访问（端口 43000）
- **快捷跳转面板** — 密码保护的入口页（端口 53000）
- **备份自动同步** — 监听 `data/backups/`，新备份文件实时推送到远端（S3 / WebDAV）

## 部署

```bash
# 1. 部署官方项目
git clone https://github.com/AmigaMeow/puppy-stardew-server.git
cd puppy-stardew-server
cp .env.example .env   # 配置 Steam 凭证
./init.sh
docker compose up -d

# 2. 部署外挂模块
git clone https://github.com/<你的账号>/puppy-stardew-addons.git custom-addons
docker compose -f custom-addons/docker-compose.yml up -d
```

## 配置备份同步

访问 `http://服务器IP:53000` → 输入密码 → 点击 **☁️ 备份同步** → 展开表单。

支持两种目标：
- **S3 兼容对象存储** — 任意 S3 兼容服务（AWS、MinIO、阿里云 OSS 等）
- **WebDAV** — 支持 WebDAV 协议的网盘或服务器

配置保存后自动生效，新备份文件产生后实时推送，远端保留最新 20 份。

## 访问入口

| 地址 | 用途 |
|---|---|
| `http://服务器IP:53000` | 快捷跳转面板（密码：登入页面显示） |
| `http://服务器IP:43000` | noVNC 远程桌面 |
| `http://服务器IP:18642` | 官方管理面板 |

## 迁移

```bash
# 打包存档和配置
tar czf stardew-migrate.tar.gz \
  -C /root/puppy-stardew-server data/ \
  -C /root custom-addons/

# 新服务器部署
tar xzf stardew-migrate.tar.gz
# 部署官方项目 + 外挂模块
```
