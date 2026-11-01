#!/bin/bash
# 文学杀 · 一键部署（Alibaba Cloud Linux / CentOS / RHEL 系）
set -e

echo "=== 1/5 装 Node 22 ==="
if ! command -v node >/dev/null 2>&1; then
  cd /tmp
  curl -fsSL -o node.tar.xz https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz
  tar xf node.tar.xz -C /opt
  ln -sf /opt/node-v22.11.0-linux-x64/bin/node /usr/bin/node
  ln -sf /opt/node-v22.11.0-linux-x64/bin/npm /usr/bin/npm
fi
node -v

echo "=== 2/5 装 git ==="
command -v git >/dev/null 2>&1 || (dnf install -y git || yum install -y git)

echo "=== 3/5 拉代码 ==="
rm -rf /opt/wenxuesha
git clone --depth 1 https://github.com/unknown111-commits/un.git /opt/wenxuesha
cd /opt/wenxuesha
npm install --omit=dev

echo "=== 4/5 配开机自启和守护 ==="
cat > /etc/systemd/system/wenxuesha.service <<'UNIT'
[Unit]
Description=Wenxuesha
After=network.target

[Service]
WorkingDirectory=/opt/wenxuesha
ExecStart=/usr/bin/node server.js
Environment=PORT=8899
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable wenxuesha
systemctl restart wenxuesha
sleep 2

echo "=== 5/5 系统防火墙放行 8899 ==="
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=8899/tcp || true
  firewall-cmd --reload || true
fi

echo ""
echo "================================================"
systemctl is-active wenxuesha
IP=$(curl -s --max-time 5 ifconfig.me || echo "你的公网IP")
echo "服务地址：http://$IP:8899"
echo "================================================"
