#!/usr/bin/env python3
"""
Dian Dev Sync 测试客户端 (Python)
用法:
    python test-client.py --token your-token --plugin-name my-plugin --dist ./dist
"""

import argparse
import base64
import json
import os
import sys
import time
import zipfile
from io import BytesIO

import websocket  # pip install websocket-client


def pack_dir_to_base64(directory: str) -> str:
    """将目录打包成 base64 编码的 zip"""
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(directory):
            for file in files:
                full = os.path.join(root, file)
                arc = os.path.relpath(full, directory).replace("\\", "/")
                zf.write(full, arc)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def run(ws_url: str, token: str, plugin_name: str, dist_dir: str):
    print(f"[*] Connecting to {ws_url} ...")
    ws = websocket.create_connection(ws_url)

    # 1. 认证
    auth_msg = {"type": "auth", "token": token, "pluginName": plugin_name}
    ws.send(json.dumps(auth_msg))
    print(f"[>] auth -> {plugin_name}")

    raw = ws.recv()
    data = json.loads(raw)
    print(f"[<] {data}")

    if data.get("type") == "auth-result":
        if not data.get("ok"):
            print("[!] Auth failed:", data.get("message"))
            ws.close()
            sys.exit(1)
        print("[+] Auth OK")
    else:
        print("[!] Unexpected response:", data)
        ws.close()
        sys.exit(1)

    # 2. 打包并推送
    if not os.path.isdir(dist_dir):
        print(f"[!] dist dir not found: {dist_dir}")
        ws.close()
        sys.exit(1)

    print(f"[*] Packing {dist_dir} ...")
    bundle = pack_dir_to_base64(dist_dir)
    print(f"[*] Bundle size: {len(bundle)} bytes (base64)")

    push_msg = {"type": "push-bundle", "pluginName": plugin_name, "bundle": bundle}
    ws.send(json.dumps(push_msg))
    print(f"[>] push-bundle -> {plugin_name}")

    # 3. 等待服务端响应
    while True:
        try:
            raw = ws.recv()
            data = json.loads(raw)
            print(f"[<] {data}")

            if data.get("type") == "bundle-accepted":
                print("[+] Server accepted bundle, writing files...")
            elif data.get("type") == "reload-complete":
                print("[+] Plugin reloaded successfully!")
                break
            elif data.get("type") == "reload-error":
                print("[!] Reload failed:", data.get("message"))
                break
            elif data.get("type") == "error":
                print("[!] Server error:", data.get("message"))
                break
        except websocket.WebSocketTimeoutException:
            break
        except Exception as e:
            print("[!] Exception:", e)
            break

    ws.close()
    print("[*] Connection closed")


def main():
    parser = argparse.ArgumentParser(description="Dian Dev Sync WS test client")
    parser.add_argument("--url", default="ws://127.0.0.1:3901", help="WebSocket URL")
    parser.add_argument("--token", required=True, help="Auth token")
    parser.add_argument("--plugin-name", required=True, help="Plugin name to sync")
    parser.add_argument("--dist", default="./dist", help="Dist directory to zip and push")
    args = parser.parse_args()

    run(args.url, args.token, args.plugin_name, args.dist)


if __name__ == "__main__":
    main()
