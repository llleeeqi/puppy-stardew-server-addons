#!/bin/bash
# Puppy Stardew Server Addons - Quick Start
# 外挂模块一键部署脚本

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  🍄 Puppy Stardew Server Addons${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check Docker
if ! docker ps &>/dev/null; then
  echo -e "${RED}❌ Docker 未运行${NC}"
  exit 1
fi

# Check official container
OFFICIAL_RUNNING=false
if docker ps --format '{{.Names}}' | grep -q 'puppy-stardew$'; then
  OFFICIAL_RUNNING=true
else
  echo -e "${YELLOW}⚠️  未检测到官方容器 (puppy-stardew)${NC}"
  echo -e "${YELLOW}   请先部署官方项目：${NC}"
  echo -e "    ${CYAN}curl -sSL https://raw.githubusercontent.com/AmigaMeow/puppy-stardew-server/main/quick-start.sh | bash${NC}"
  echo ""
  read -rp "是否继续安装外挂（之后手动启动官方容器）？(y/n): " skip_check
  [[ "$skip_check" =~ ^[Yy]$ ]] || exit 1
fi

# Ensure Docker network exists
if $OFFICIAL_RUNNING; then
  echo -e "${GREEN}✅ 检测到官方容器运行中${NC}"
fi
if ! docker network ls --format '{{.Name}}' | grep -q 'puppy-stardew-server_default'; then
  echo -e "${YELLOW}⚠️  创建 Docker 网络 (puppy-stardew-server_default)${NC}"
  docker network create puppy-stardew-server_default 2>/dev/null || true
fi

# Download addons
ADDONS_DIR="puppy-stardew-server-addons"
if [ -d "$ADDONS_DIR" ]; then
  echo -e "${YELLOW}⚠️  目录已存在，更新中...${NC}"
  cd "$ADDONS_DIR" && git pull && cd ..
else
  echo -e "${GREEN}📦 下载外挂模块...${NC}"
  if command -v git &>/dev/null; then
    git clone https://github.com/llleeeqi/puppy-stardew-server-addons.git "$ADDONS_DIR"
  elif command -v wget &>/dev/null; then
    wget -qO addons.tar.gz "https://github.com/llleeeqi/puppy-stardew-server-addons/archive/main.tar.gz"
    mkdir -p "$ADDONS_DIR" && tar xzf addons.tar.gz -C "$ADDONS_DIR" --strip-components=1 && rm addons.tar.gz
  else
    echo -e "${RED}❌ 需要 git 或 wget${NC}"; exit 1
  fi
fi

cd "$ADDONS_DIR"

# Configure
if [ -f ".env" ]; then
  echo ""
  read -rp ".env 已存在，是否重新配置？(y/n): " reconfigure
  [[ "$reconfigure" =~ ^[Yy]$ ]] || { echo -e "${GREEN}🚀 启动容器...${NC}"; docker compose up -d; echo -e "${GREEN}✅ 完成${NC}"; exit 0; }
fi

cp .env.example .env

echo ""
echo -e "${CYAN}════════════════════════════════════════${NC}"
echo -e "${CYAN}  配置外挂模块${NC}"
echo -e "${CYAN}════════════════════════════════════════${NC}"
echo ""

read -rp "设置登录密码: " login_pass
read -rp "设置 VNC 密码: " vnc_pass

# 自动检测服务器 IP
server_ip=""
if $OFFICIAL_RUNNING; then
  # 从官方容器获取公网 IP
  server_ip=$(docker inspect puppy-stardew --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^PUBLIC_IP=' | cut -d= -f2 || true)
fi
# 从上级目录的 .env 获取
if [ -z "$server_ip" ] && [ -f "../.env" ]; then
  server_ip=$(grep -oP 'PUBLIC_IP=\K.*' ../.env 2>/dev/null || true)
fi
# 询问用户
if [ -z "$server_ip" ]; then
  read -rp "服务器公网 IP 或域名: " server_ip
fi

# 更新 .env
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/LOGIN_PASSWORD=.*/LOGIN_PASSWORD=$login_pass/" .env
  sed -i '' "s/VNC_PASSWORD=.*/VNC_PASSWORD=$vnc_pass/" .env
  sed -i '' "s/SERVER_IP=.*/SERVER_IP=$server_ip/" .env
else
  sed -i "s/LOGIN_PASSWORD=.*/LOGIN_PASSWORD=$login_pass/" .env
  sed -i "s/VNC_PASSWORD=.*/VNC_PASSWORD=$vnc_pass/" .env
  sed -i "s/SERVER_IP=.*/SERVER_IP=$server_ip/" .env
fi

echo ""
echo -e "${GREEN}✅ 配置完成${NC}"
echo -e "${GREEN}🚀 启动容器...${NC}"

docker compose up -d

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✅ 外挂模块部署完成！${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  🏠 跳转面板:  ${CYAN}http://$server_ip:53000${NC}"
echo -e "  🖥️  noVNC:    ${CYAN}http://$server_ip:43000${NC}"
echo -e "  📊 管理面板:  ${CYAN}http://$server_ip:18642${NC}"
echo ""
