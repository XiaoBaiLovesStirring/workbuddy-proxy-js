#!/bin/bash
# WorkBuddy Proxy 自动安装脚本 (Linux/macOS)
# 安装到 ~/.config/workbuddyaip/ 并注册系统命令

set -e

CONFIG_DIR="$HOME/.config/workbuddyaip"
API_DIR="$CONFIG_DIR/API"
LOG_DIR="$CONFIG_DIR/logs"
BIN_DIR="$HOME/.local/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=========================================="
echo "  WorkBuddy Proxy 安装脚本"
echo "=========================================="

# 创建目录
echo "==> 创建配置目录..."
mkdir -p "$API_DIR" "$LOG_DIR" "$BIN_DIR"

# 复制项目文件到配置目录（如果不是已经在那里）
if [ "$SCRIPT_DIR" != "$CONFIG_DIR/app" ]; then
  echo "==> 安装程序文件..."
  rm -rf "$CONFIG_DIR/app"
  cp -r "$SCRIPT_DIR" "$CONFIG_DIR/app"
  # 清理 node_modules，重新安装
  rm -rf "$CONFIG_DIR/app/node_modules"
fi

# 安装依赖
echo "==> 安装 Node.js 依赖..."
cd "$CONFIG_DIR/app"
if command -v npm &> /dev/null; then
  npm install --production 2>&1 | tail -3
else
  echo "错误: 未找到 npm，请先安装 Node.js"
  exit 1
fi

# 创建启动命令
echo "==> 注册系统命令..."
cat > "$BIN_DIR/workbuddy-proxy" << 'EOF'
#!/bin/bash
# WorkBuddy Proxy 启动命令
CONFIG_DIR="$HOME/.config/workbuddyaip"
cd "$CONFIG_DIR/app"
exec node src/server.js "$@"
EOF
chmod +x "$BIN_DIR/workbuddy-proxy"

# 创建停止命令
cat > "$BIN_DIR/workbuddy-proxy-stop" << 'STOPEOF'
#!/bin/bash
# 停止 WorkBuddy Proxy
PID_FILE="$HOME/.config/workbuddyaip/proxy.pid"
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" 2>/dev/null
    fi
    echo "已停止 (PID: $PID)"
  else
    echo "进程不存在，清理 PID 文件"
    rm -f "$PID_FILE"
  fi
else
  # 兜底：按进程名查找
  pkill -f "workbuddy-proxy/src/server.js" 2>/dev/null && echo "已停止" || echo "未运行"
fi
STOPEOF
chmod +x "$BIN_DIR/workbuddy-proxy-stop"

# 创建状态命令
cat > "$BIN_DIR/workbuddy-proxy-status" << 'STATEOF'
#!/bin/bash
# 查看 WorkBuddy Proxy 状态
PID_FILE="$HOME/.config/workbuddyaip/proxy.pid"
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "运行中 (PID: $PID)"
    curl -s http://127.0.0.1:8788/health 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "健康检查失败"
  else
    echo "未运行 (PID 文件存在但进程已退出)"
  fi
else
  if pgrep -f "workbuddy-proxy/src/server.js" > /dev/null; then
    echo "运行中 (PID: $(pgrep -f 'workbuddy-proxy/src/server.js'))"
  else
    echo "未运行"
  fi
fi
STATEOF
chmod +x "$BIN_DIR/workbuddy-proxy-status"

# 注册到 shell 配置文件
SHELL_NAME=$(basename "$SHELL")
RC_FILE=""
case "$SHELL_NAME" in
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  bash) RC_FILE="$HOME/.bashrc" ;;
  fish) RC_FILE="$HOME/.config/fish/config.fish" ;;
esac

if [ -n "$RC_FILE" ] && ! grep -q "workbuddy-proxy" "$RC_FILE" 2>/dev/null; then
  echo "==> 注册到 $RC_FILE..."
  echo "" >> "$RC_FILE"
  echo "# WorkBuddy Proxy" >> "$RC_FILE"
  echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$RC_FILE"
fi

# systemd 用户服务（可选）
if command -v systemctl &> /dev/null && [ -d "$HOME/.config/systemd/user" ]; then
  echo "==> 配置 systemd 用户服务..."
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/workbuddy-proxy.service" << EOF
[Unit]
Description=WorkBuddy Proxy Server
After=network.target

[Service]
Type=simple
ExecStart=$BIN_DIR/workbuddy-proxy
Restart=always
RestartSec=10
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload 2>/dev/null || true
  echo "  启用自启: systemctl --user enable --now workbuddy-proxy"
fi

echo ""
echo "=========================================="
echo "  安装完成！"
echo "=========================================="
echo ""
echo "  配置目录: $CONFIG_DIR"
echo "  账号目录: $API_DIR (放入 .json 账号文件自动导入)"
echo "  日志目录: $LOG_DIR"
echo ""
echo "  命令:"
echo "    启动:  workbuddy-proxy"
echo "    停止:  workbuddy-proxy-stop"
echo "    状态:  workbuddy-proxy-status"
echo ""
echo "  管理页: http://127.0.0.1:8788/"
echo "  API:    http://127.0.0.1:8788/v1"
echo ""
echo "  提示: 将账号 JSON 文件放到 $API_DIR 后重启即可自动导入"
echo "=========================================="

# 询问是否立即启动
read -p "立即启动代理？[Y/n] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
  echo "==> 启动代理..."
  "$BIN_DIR/workbuddy-proxy"
fi
