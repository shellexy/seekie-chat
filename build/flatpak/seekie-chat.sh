#!/bin/sh
# Flatpak 已经在外面套了一层沙箱；Chromium 自己的那一层在这里起不来：/app 里的
# chrome-sandbox 不会保留 setuid 位，沙箱内的用户命名空间也被 Flatpak 关掉，Electron 会
# 直接报 "SUID sandbox helper binary was found, but is not configured correctly" 然后退出。
# 所以沿用 AppImage 的做法显式关掉——隔离由 Flatpak 负责。
exec /app/seekie-chat/seekie-chat --no-sandbox "$@"
