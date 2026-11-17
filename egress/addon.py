"""サンドボックス用の egress プロキシ (mitmproxy アドオン)。

役割:
  1. サンドボックスからの外向き通信を許可リストで判定する (デフォルト拒否)
  2. 許可された宛先へのリクエストにだけ、本物のクレデンシャルを付与する

サンドボックス内にはプレースホルダー (dummy-placeholder) しか置かず、
このプロキシが通信の瞬間に本物のトークンへ差し替える。
宛先制御はホスト + メソッド + パスの単位 (GitHub の書き込みは自 org のみ)。
"""
import base64
import os
import re

from mitmproxy import http

REAL_GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
PLACEHOLDER = "dummy-placeholder"

# 対象の GitHub org / ユーザー名
ORG = ""

# (host, methods, path regex) の許可リスト。ここに無い通信は 403 で落とす。
ALLOW = [
    ("api.github.com", {"GET"}, re.compile(r"^/")),
    ("api.github.com", {"POST", "PATCH", "PUT", "DELETE"}, re.compile(rf"^/repos/{ORG}/")),
    ("github.com", {"GET", "POST"}, re.compile(rf"^/{ORG}/")),
    ("codeload.github.com", {"GET"}, re.compile(r"^/")),
    ("raw.githubusercontent.com", {"GET"}, re.compile(r"^/")),
]


def _inject(auth: str) -> str:
    """Authorization ヘッダ内のプレースホルダーを本物のトークンに差し替える。"""
    if not REAL_GITHUB_TOKEN or PLACEHOLDER not in auth:
        return auth
    if auth.startswith("Basic "):
        # git の HTTPS アクセス: Basic base64(user:token) の token 部分を差し替える
        try:
            decoded = base64.b64decode(auth[6:]).decode()
            replaced = decoded.replace(PLACEHOLDER, REAL_GITHUB_TOKEN)
            return "Basic " + base64.b64encode(replaced.encode()).decode()
        except Exception:
            return auth
    return auth.replace(PLACEHOLDER, REAL_GITHUB_TOKEN)


class Egress:
    def request(self, flow: http.HTTPFlow) -> None:
        host = flow.request.pretty_host
        method = flow.request.method
        path = flow.request.path.split("?")[0]
        allowed = any(
            h == host and method in methods and rx.match(path)
            for h, methods, rx in ALLOW
        )
        if not allowed:
            flow.response = http.Response.make(
                403,
                b"denied by egress policy",
                {"content-type": "text/plain"},
            )
            return
        auth = flow.request.headers.get("Authorization", "")
        if auth:
            flow.request.headers["Authorization"] = _inject(auth)


addons = [Egress()]
