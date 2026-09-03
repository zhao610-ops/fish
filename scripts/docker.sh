#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CONFIG_DIR="$PROJECT_DIR/config"

compose() {
  docker compose --project-directory "$PROJECT_DIR" -f "$PROJECT_DIR/docker-compose.yml" "$@"
}

require_config() {
  if [ ! -f "$CONFIG_DIR/trendpublish.config.ts" ] || [ ! -f "$CONFIG_DIR/runtime.env" ]; then
    echo "请先执行：sh scripts/docker.sh init，然后填写 config 目录中的配置。" >&2
    exit 1
  fi
}

require_engine() {
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo "Docker 引擎未就绪，请先启动 Docker Desktop。" >&2
    exit 1
  fi
}

case "${1:-help}" in
  init)
    mkdir -p "$CONFIG_DIR"
    if [ ! -e "$CONFIG_DIR/trendpublish.config.ts" ]; then
      cp "$PROJECT_DIR/trendpublish.config.docker.example.ts" "$CONFIG_DIR/trendpublish.config.ts"
    fi
    if [ ! -e "$CONFIG_DIR/runtime.env" ]; then
      (umask 077; cp "$PROJECT_DIR/docker/runtime.env.example" "$CONFIG_DIR/runtime.env")
      chmod 600 "$CONFIG_DIR/runtime.env"
    fi
    echo "配置目录：${CONFIG_DIR}（已有文件保持不变）"
    echo "填写 runtime.env 的后台密钥、模型及抓取服务，再配置来源与授权。"
    ;;
  up)
    require_config
    require_engine
    compose up -d --build --wait --wait-timeout 120
    echo "后台：http://localhost:8000/dashboard/"
    ;;
  build)
    require_engine
    docker build -t trendpublish:local "$PROJECT_DIR"
    ;;
  doctor|preview)
    require_config
    require_engine
    if [ "$1" = doctor ]; then
      compose run --rm --no-deps trendpublish deno task doctor
    else
      # 始终显式预览，不接受可切换成真实发送的附加参数。
      compose run --rm --no-deps trendpublish deno task article --dry-run
    fi
    ;;
  restart)
    require_config
    require_engine
    # 重新创建容器才能载入更新后的运行变量，数据卷保留。
    compose up -d --force-recreate --wait --wait-timeout 120
    ;;
  logs)
    require_config
    require_engine
    compose logs --tail=100 -f trendpublish
    ;;
  status)
    require_config
    require_engine
    compose ps
    ;;
  stop)
    require_config
    require_engine
    compose down
    ;;
  *)
    echo "用法：sh scripts/docker.sh init|build|up|doctor|preview|restart|logs|status|stop"
    echo "无需在宿主机安装 Deno。默认仅预览，stop 不删除持久化数据卷。"
    ;;
esac
