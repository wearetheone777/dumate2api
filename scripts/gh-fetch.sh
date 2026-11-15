#!/bin/bash
# gh-fetch.sh - 在 GitHub 直连不可用的机器上取仓库正文（2026-11-16 实测可用）
#
# 背景：本机 raw.githubusercontent.com / cdn.jsdelivr.net / github.com 的 TCP 能连，
# 但 TLS 被 reset（IPv4 185.199.108-111.133 与 IPv6 2606:50c0:* 都一样），
# 只有 api.github.com（20.205.243.x）通。而 api 匿名额度只有 60/小时。
#
# 所以按「不耗额度优先」的顺序试三条镜像，最后才回落官方 API：
#   1) gcore.jsdelivr.net   —— CDN，无额度、最快，路径形态 gh/{repo}@{branch}/{path}
#   2) gh-proxy.com         —— 反代，把完整 raw URL 拼在后面
#   3) ghproxy.net          —— 同上（互备）
#   4) api.github.com       —— 官方 contents/readme，base64 解码，耗 1 次额度
#
# 用法：
#   ./gh-fetch.sh file <owner/repo> <path> [outfile]   # path 如 README.md / docs/OAUTH.md
#   ./gh-fetch.sh tree <owner/repo> [branch]           # 列出仓库全部文件（jsDelivr data API）
#   ./gh-fetch.sh url  <https://raw.githubusercontent.com/...>  [outfile]
#
# 退出码：0 成功（并打印实际命中的通道）；1 全部失败。
set -u

MODE="${1:-}"
[ -z "$MODE" ] && { sed -n '2,20p' "$0"; exit 2; }

UA="Mozilla/5.0 (compatible; dumate2api-research)"

try_get() { # $1=url $2=out
  local code
  code=$(curl -sL -m 25 -A "$UA" -o "$2" -w '%{http_code}' "$1" 2>/dev/null)
  if [ "$code" = "200" ] && [ -s "$2" ]; then echo "$code"; return 0; fi
  echo "$code"; return 1
}

fetch_path() { # $1=owner/repo $2=path $3=out
  local repo="$1" path="$2" out="$3" code

  # 1) jsDelivr (gcore)
  if code=$(try_get "https://gcore.jsdelivr.net/gh/${repo}@main/${path}" "$out"); then
    echo "OK jsdelivr  $repo/$path -> $out ($(wc -c < "$out") bytes)"; return 0
  fi
  # jsDelivr 上仓库默认分支是 master 的少数情况
  if code=$(try_get "https://gcore.jsdelivr.net/gh/${repo}@master/${path}" "$out"); then
    echo "OK jsdelivr(master) $repo/$path -> $out ($(wc -c < "$out") bytes)"; return 0
  fi

  # 2) gh-proxy
  if code=$(try_get "https://gh-proxy.com/https://raw.githubusercontent.com/${repo}/main/${path}" "$out"); then
    echo "OK gh-proxy  $repo/$path -> $out ($(wc -c < "$out") bytes)"; return 0
  fi
  # 3) ghproxy.net
  if code=$(try_get "https://ghproxy.net/https://raw.githubusercontent.com/${repo}/main/${path}" "$out"); then
    echo "OK ghproxy.net $repo/$path -> $out ($(wc -c < "$out") bytes)"; return 0
  fi

  # 4) 官方 API（需要额度；base64）
  local tmp="${out}.b64"
  if code=$(try_get "https://api.github.com/repos/${repo}/contents/${path}" "$tmp"); then
    if node -e '
      const fs=require("fs");const p=process.argv[1];
      const j=JSON.parse(fs.readFileSync(p,"utf8"));
      if(!j||!j.content) process.exit(3);
      fs.writeFileSync(process.argv[2], Buffer.from(j.content,j.encoding||"base64"));
    ' "$tmp" "$out" 2>/dev/null; then
      rm -f "$tmp"
      echo "OK api       $repo/$path -> $out ($(wc -c < "$out") bytes)"; return 0
    fi
  fi
  rm -f "$tmp" "$out"
  echo "FAIL $repo/$path（jsdelivr / gh-proxy / ghproxy.net / api 全失败）" >&2
  return 1
}

case "$MODE" in
  file)
    fetch_path "${2:?owner/repo}" "${3:?path}" "${4:-./$(echo "${2}_${3}" | tr '/' '_')}"
    ;;
  url)
    src="${2:?url}"
    out="${3:-./fetched.txt}"
    if code=$(try_get "https://gh-proxy.com/${src}" "$out"); then
      echo "OK gh-proxy $out ($(wc -c < "$out") bytes)"
    elif code=$(try_get "https://ghproxy.net/${src}" "$out"); then
      echo "OK ghproxy.net $out ($(wc -c < "$out") bytes)"
    else
      echo "FAIL $src" >&2; exit 1
    fi
    ;;
  tree)
    repo="${2:?owner/repo}"; branch="${3:-main}"
    if code=$(try_get "https://data.jsdelivr.com/v1/packages/gh/${repo}@${branch}?structure=flat" /tmp/.gh_tree.json); then
      node -e '
        const j=require("/tmp/.gh_tree.json");
        (j.files||[]).forEach(f=>console.log(String(f.size).padStart(9)+"  "+f.name));
      '
    else
      echo "FAIL tree $repo（data.jsdelivr.com 不可达）" >&2; exit 1
    fi
    ;;
  *) echo "unknown mode: $MODE（file | tree | url）" >&2; exit 2 ;;
esac
