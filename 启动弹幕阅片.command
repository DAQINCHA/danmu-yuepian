#!/bin/zsh
# 双击启动「弹幕阅片」（macOS）。脚本按自身所在目录定位项目，整个文件夹可以搬到任何位置。
cd -- "${0:A:h}" || exit 1

port=5280
health='/api/health'
node_probe='process.exit(process.versions.node.split(".")[0] >= 18 ? 0 : 1)'
node_min='18'

clear
print -n "\e]0;弹幕阅片 · 本地服务\a"

pause_exit() {
  print ''
  print -n '  按任意键关闭窗口…'
  read -k 1 -s
  print ''
  exit "${1:-1}"
}

# 找一个能用的 Node：PATH → Homebrew → /usr/local → Volta → nvm → Codex/ChatGPT 客户端运行时 → WorkBuddy 自带
versions="$HOME/.workbuddy/binaries/node/versions"
candidates=( "${commands[node]}" /opt/homebrew/bin/node /usr/local/bin/node )
candidates+=( "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node(N) )
candidates+=( "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" "$HOME/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" )
[[ -f "$versions/current" ]] && candidates+=( "$versions/$(<"$versions/current")/bin/node" )
candidates+=( "$versions"/*/bin/node(N) )

node_bin=''
for candidate in $candidates; do
  [[ -x "$candidate" ]] || continue
  if "$candidate" -e "$node_probe" >/dev/null 2>&1; then
    node_bin="$candidate"
    break
  fi
done

if [[ -z "$node_bin" ]]; then
  print ''
  print '  没有找到可用的 Node.js。'
  print "  需要 ${node_min} 或更高版本，安装后重新双击本文件即可。"
  print '  下载地址：https://nodejs.org/'
  pause_exit 1
fi

lan_ip=''
for iface in en0 en1 en2 en3; do
  lan_ip="$(ipconfig getifaddr "$iface" 2>/dev/null)"
  [[ -n "$lan_ip" ]] && break
done

url="http://127.0.0.1:${port}"

export HOST=0.0.0.0
export PORT="$port"

if curl -fsS --max-time 2 "${url}${health}" >/dev/null 2>&1; then
  print ''
  print '  服务已在运行，无需重复启动。'
  print "  本机    ${url}"
  [[ -n "$lan_ip" ]] && print "  局域网  http://${lan_ip}:${port}"
  print '  已为你打开浏览器。'
  print ''
  open "$url"
  exit 0
fi

if lsof -ti "tcp:${port}" >/dev/null 2>&1; then
  print ''
  print "  无法启动：端口 ${port} 已被其他程序占用。"
  print '  请先关闭占用该端口的程序，或用 PORT 指定其他端口。'
  pause_exit 1
fi

(
  for _ in {1..50}; do
    if curl -fsS --max-time 1 "${url}${health}" >/dev/null 2>&1; then
      open "$url"
      exit 0
    fi
    sleep 0.2
  done
) &


"$node_bin" server.js
exit_code=$?

print ''
if (( exit_code == 0 || exit_code == 130 )); then
  print '  服务已停止。'
  print ''
else
  print "  启动失败（退出码 ${exit_code}）。"
  print '  上方是服务的错误输出，修好之后重新双击本文件即可。'
  pause_exit "$exit_code"
fi
