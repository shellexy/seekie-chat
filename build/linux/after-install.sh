#!/bin/bash
# 让命令行能直接敲 seekie-chat。/opt 下的可执行文件不在 PATH 里。
# 路径与 package.json 的 build.productName 对应：productName 改了这里也要改。
ln -sfn "/opt/seekie-chat/seekie-chat" /usr/bin/seekie-chat
