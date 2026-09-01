"""DIAG: can USER token (VK_TOKEN) upload photos to LostArt group (226242897)?
Tests photos.getWallUploadServer + upload + photos.saveWallPhoto with group_id.
Group token path fails with error 27 — user token may work if owner is admin.
"""
import os, base64, requests

API = "https://api.vk.com/method/"
TOKEN = os.environ["VK_TOKEN"]
GROUP_ID = os.environ.get("DIAG_GROUP_ID", "226242897")  # LostArt

def call(method, **params):
    params.update(access_token=TOKEN, v="5.199")
    r = requests.post(API + method, data=params, timeout=20)
    return r.json()

print("== photos.getWallUploadServer (user token, group_id=%s) ==" % GROUP_ID)
r = call("photos.getWallUploadServer", group_id=GROUP_ID)
print(r)
if "response" not in r:
    print("RESULT: FAIL getWallUploadServer")
    raise SystemExit(1)
url = r["response"]["upload_url"]

# tiny 1x1 PNG
png = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
r2 = requests.post(url, files={"photo": ("t.png", png, "image/png")}, timeout=20)
print("== upload ==")
print(r2.text)
try:
    up = r2.json()
except Exception:
    print("RESULT: FAIL upload (non-JSON)")
    raise SystemExit(1)

r3 = call(
    "photos.saveWallPhoto",
    group_id=GROUP_ID,
    photo=up.get("photo", ""),
    server=up.get("server", ""),
    hash=up.get("hash", ""),
)
print("== photos.saveWallPhoto ==")
print(r3)
if "response" in r3 and r3["response"]:
    pid = r3["response"][0]
    print("RESULT: OK photo owner_id=%s id=%s" % (pid.get("owner_id"), pid.get("id")))
else:
    print("RESULT: FAIL saveWallPhoto")
    raise SystemExit(1)