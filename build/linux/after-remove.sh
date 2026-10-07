#!/bin/bash
# 升级时 dpkg 会先 postrm(remove) 再 postinst，所以只在真正卸载/清除时删。
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  rm -f /usr/bin/seekie-chat
fi
