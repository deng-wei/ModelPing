#!/bin/sh
# ModelPing 容器出网隔离（nftables 版，适配 OpenWrt / IStoreOS fw4）。
# 禁止 modelping 容器主动访问内网（服务器网段 / 其它容器 / 云元数据），放行所有公网目标。
#
# 为什么用 nft 而非 iptables 的 DOCKER-USER 链：
#   IStoreOS 用 nftables（iptables 是 nf_tables 兼容层），Docker 在此不创建传统的
#   DOCKER-USER 链，所以基于该链的规则无效。改为建一张独立表 inet modelping，
#   挂 forward 钩子、优先级 -200（排在 fw4 / docker 的转发规则之前先判定）。
#
# 原理：modelping 跑在 docker-compose 固定子网 172.31.66.0/24（networks.egress）。
#   只丢弃「源=该子网、目标=私有段、且 ct state new（容器主动新建）」的转发包。
#   - 容器主动连内网（SSRF）→ new + 私有目标 → DROP。
#   - 容器连公网 → 目标不在私有段 → 放行。
#   - 内网/反代访问容器 8787 的回程包 → established（非 new）→ 放行，不误伤入站。
#   - 容器到网关(宿主)走 input 而非 forward，本就不受影响。
#   独立表不影响 fw4，fw4 reload 不会清掉它；仅在「reboot / nft flush ruleset」后消失。
#
# 用法：sh deploy/firewall-egress.sh   （docker compose up -d 之后执行；幂等，可重复跑）

set -eu

SUBNET="172.31.66.0/24"   # 与 docker-compose.yml networks.egress.subnet 保持一致

# 幂等：先删除同名表再重建。
nft delete table inet modelping 2>/dev/null || true
nft add table inet modelping
nft add chain inet modelping forward '{ type filter hook forward priority -200; policy accept; }'
nft add rule inet modelping forward \
  ip saddr "$SUBNET" \
  ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 127.0.0.0/8 } \
  ct state new counter drop

echo "[ok] 已对 $SUBNET 拦截到内网私有段的主动访问。当前规则："
nft list table inet modelping | sed 's/^/    /'

# —— 持久化 ——
# 独立表在「重启」后消失（fw4 reload / dockerd 重启都不影响它）。
# nft 规则用的是子网字面量，不依赖网桥/容器已存在，因此开机早于 docker 起来也能加。
# 推荐二选一：
#
# A. 开机自动加载（最直接）：把本脚本拷到固定路径，在 /etc/rc.local 的 `exit 0` 之前加一行调用：
#       cp deploy/firewall-egress.sh /etc/firewall.modelping.sh
#       # 然后编辑 /etc/rc.local，在 exit 0 前加： sh /etc/firewall.modelping.sh
#
# B. cron 兜底（顺带自愈，若规则被误清 5 分钟内恢复）：
#       cp deploy/firewall-egress.sh /etc/firewall.modelping.sh
#       echo '*/5 * * * * /etc/firewall.modelping.sh >/dev/null 2>&1' >> /etc/crontabs/root
#       /etc/init.d/cron enable && /etc/init.d/cron restart
