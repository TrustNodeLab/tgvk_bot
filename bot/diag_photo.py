"""DIAG: can USER token (VK_TOKEN) upload photos to LostArt group (226242897)?
Tests photos.getWallUploadServer + upload + photos.saveWallPhoto with group_id.
Group token path fails with error 27 — user token may work if owner is admin.
Uses only stdlib (urllib) to avoid pip install on runner.
"""
import os, base64, json, urllib.request, urllib.parse

API = "https://api.vk.com/method/"
TOKEN = os.environ["VK_TOKEN"]
GROUP_ID = os.environ.get("DIAG_GROUP_ID", "226242897")  # LostArt

def call(method, **params):
    params.update(access_token=TOKEN, v="5.199")
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(API + method, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

print("== photos.getWallUploadServer (user token, group_id=%s) ==" % GROUP_ID)
r = call("photos.getWallUploadServer", group_id=GROUP_ID)
print(json.dumps(r, ensure_ascii=False))
if "response" not in r:
    print("RESULT: FAIL getWallUploadServer")
    raise SystemExit(1)
url = r["response"]["upload_url"]

# tiny 1x1 PNG
png = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
boundary = "----diag123"
body = (
    ("--" + boundary + "\r\n"
     'Content-Disposition: form-data; name="photo"; filename="t.png"\r\n'
     "Content-Type: image/png\r\n\r\n").encode() + png + ("\r\n--" + boundary + "--\r\n").encode()
)
req = urllib.request.Request(url, data=body, method="POST")
req.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
with urllib.request.urlopen(req, timeout=20) as r:
    up_raw = r.read().decode()
print("== upload ==")
print(up_raw)
try:
    up = json.loads(up_raw)
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
print(json.dumps(r3, ensure_ascii=False))
if "response" in r3 and r3["response"]:
    pid = r3["response"][0]
    print("RESULT: OK photo owner_id=%s id=%s" % (pid.get("owner_id"), pid.get("id")))
else:
    print("RESULT: FAIL saveWallPhoto")
    raise SystemExit(1)