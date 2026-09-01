"""ВРЕМЕННАЯ диагностика VK API для групповых токенов. Удалить после анализа."""
import io
import json
import os

import requests
from PIL import Image

API = "https://api.vk.com/method/"
V = "5.199"
TOKEN = os.environ["VK_TOKEN_LOSTART"]
GID = 226242897


def call(method, **params):
    params["access_token"] = TOKEN
    params["v"] = V
    r = requests.post(API + method, data=params, timeout=30)
    try:
        return r.json()
    except Exception:
        return {"raw": r.text[:300]}


def make_png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (200, 60, 120)).save(buf, "PNG")
    return buf.getvalue()


def do_upload(server_method, save_method, save_keys, use_group=True, label=""):
    sp = {"group_id": GID} if use_group else {}
    info = call(server_method, **sp)
    print(f"[{label}] {server_method} -> {json.dumps(info, ensure_ascii=False)[:400]}")
    resp = info.get("response") or {}
    url = resp.get("upload_url")
    if not url:
        print(f"[{label}] NO upload_url")
        return
    png = make_png()
    ur = requests.post(url, files={"file": ("card.png", png, "image/png")}, timeout=60).json()
    print(f"[{label}] upload -> {json.dumps(ur, ensure_ascii=False)[:400]}")
    params = {k: ur.get(k) for k in save_keys if ur.get(k) is not None}
    if use_group:
        params["group_id"] = GID
    if "album_id" in save_keys and resp.get("album_id"):
        params["album_id"] = resp["album_id"]
    res = call(save_method, **params)
    print(f"[{label}] {save_method} -> {json.dumps(res, ensure_ascii=False)[:700]}")


print("TOKEN prefix:", TOKEN[:6], "len:", len(TOKEN))
print("== 1. docs.getWallUploadServer БЕЗ group_id ==")
print(json.dumps(call("docs.getWallUploadServer"), ensure_ascii=False)[:400])
print("== 2. docs c group_id (ожидаем error 15) ==")
do_upload("docs.getWallUploadServer", "docs.save", ["file"], use_group=True, label="docs-gid")
print("== 3. photos.getWallUploadServer + saveWallPhoto c group_id ==")
do_upload(
    "photos.getWallUploadServer",
    "photos.saveWallPhoto",
    ["server", "photo", "hash"],
    use_group=True,
    label="photo-wall",
)
print("== 4. photos.getUploadServer + photos.save (альбом) c group_id ==")
do_upload(
    "photos.getUploadServer",
    "photos.save",
    ["server", "photos_list", "album_id", "hash"],
    use_group=True,
    label="photo-album",
)
print("== 5. docs БЕЗ group_id: getWallUploadServer + save ==")
do_upload("docs.getWallUploadServer", "docs.save", ["file"], use_group=False, label="docs-nogid")
print("DONE")