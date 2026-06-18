#!/bin/sh
# ModelPing 容器出网隔离：禁止容器访问内网（服务器网段 / 其它容器 / 云元数据），
# 但放行所有公网目标（允许任意自定义 baseUrl）。
#
# 原理：modelping 跑在 docker-compose 定义的固定子网 172.31.66.0/24（networks.egress）。
# 在 Docker 的 DOCKER-USER 链（FORWARD 阶段、先于 Docker 自身规则）丢弃
# 「该子网 -> 私有地址段」且 **NEW（容器主动新建）** 的连接。
# - 容器主动连内网（SSRF）→ NEW + 目标私有段 → DROP。
# - 容器连公网 → 目标不在私有段 → 放行。
# - 内网设备/反代访问容器 8787 的回程包 → ESTABLISHED（非 NEW）→ 放行，不误伤入站访问。
# - 容器到网关(宿主)的流量走 INPUT 而非 FORWARD，本就不受影响。
# 依赖 conntrack（xt_conntrack），OpenWrt + Docker 默认具备。
#
# 用法：
#   1) 先 docker compose up -d（确保 DOCKER-USER 链与子网已存在）
#   2) sh deploy/firewall-egress.sh
#   3) 持久化见文件末尾说明（让重启/Docker 重启后自动重建）。

set -eu

SUBNET="172.31.66.0/24"           # 与 docker-compose.yml networks.egress.subnet 保持一致
PRIVATE="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8"

# 幂等：先删除可能已存在的同名规则，再插入，避免重复执行堆叠。
for net in $PRIVATE; do
  iptables -D DOCKER-USER -s "$SUBNET" -d "$net" -m conntrack --ctstate NEW -j DROP 2>/dev/null || true
done
# 插入到链首（-I），保证在 Docker 放行规则之前生效。仅拦容器主动新建(NEW)到内网的连接。
for net in $PRIVATE; do
  iptables -I DOCKER-USER -s "$SUBNET" -d "$net" -m conntrack --ctstate NEW -j DROP
done

echo "[ok] 已对 $SUBNET 拦截到内网私有段的访问。当前 DOCKER-USER 规则："
iptables -L DOCKER-USER -n --line-numbers | sed 's/^/    /'

# DOCKER-USER 链在「dockerd 重启 / 系统重启」后会被清空，需要重新执行本脚本。
# 推荐做法（任选其一）：
#
# A. 防火墙重载钩子（最省心）：把本脚本拷到固定路径，并在 /etc/config/firewall 里加 include：
#       cp deploy/firewall-egress.sh /etc/firewall.modelping.sh
#       uci add firewall include
#       uci set firewall.@include[-1].type='script'
#       uci set firewall.@include[-1].path='/etc/firewall.modelping.sh'
#       uci set firewall.@include[-1].reload='1'
#       uci commit firewall
#    之后每次 /etc/init.d/firewall reload 或开机都会重跑。
#    注意：开机时若防火墙早于 dockerd 起来，DOCKER-USER 可能还不存在；脚本会报错但不影响系统，
#    可在 dockerd 起来后再 `/etc/init.d/firewall reload` 一次，或用方案 B 更稳。
#
# B. 跟随 Docker 启动（更稳）：让脚本在 dockerd 起来后执行，例如加一行 cron 兜底：
#       echo '*/5 * * * * /etc/firewall.modelping.sh >/dev/null 2>&1' >> /etc/crontabs/root
#       /etc/init.d/cron restart
#    每 5 分钟幂等重建一次，重启后最多 5 分钟内恢复隔离。
