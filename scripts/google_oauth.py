#!/usr/bin/env python3
"""Phase 2: get GOOGLE_REFRESH_TOKEN and prove SPEC §7 end to end.

  python3 scripts/google_oauth.py auth
  python3 scripts/google_oauth.py smoketest --refresh-token <t>

Needs scripts/client_secret.json (Desktop app OAuth client, git-ignored) and
`pip install google-auth-oauthlib requests`. The smoketest uses raw HTTP only,
so it ports 1:1 to the Worker (control-plane/src/drive.ts).
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
CLIENT_SECRET = HERE / "client_secret.json"
SCOPE = "https://www.googleapis.com/auth/drive.file"
FOLDER_NAME = "Video Factory"
CHUNK = 32 * 1024 * 1024  # SPEC §7: 32 MiB, multiple of 256 KiB
SIZE = 70 * 1024 * 1024
DRIVE = "https://www.googleapis.com/drive/v3"
UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable"


def client():
    c = json.loads(CLIENT_SECRET.read_text())
    c = c.get("installed") or c.get("web")
    return c["client_id"], c["client_secret"]


def step(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")
    if not ok:
        sys.exit(1)


def auth():
    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), [SCOPE])
    creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")
    print("\nGOOGLE_REFRESH_TOKEN (shown once, not saved):\n" + creds.refresh_token)
    cid, _ = client()
    print(f"\nGOOGLE_CLIENT_ID={cid}\nNext: python3 scripts/google_oauth.py smoketest --refresh-token <token>")


def put_chunk(uri, data, start, total):
    end = start + len(data) - 1
    return requests.put(uri, data=data, headers={"Content-Range": f"bytes {start}-{end}/{total}"}, timeout=300)


def query_offset(uri, total):
    r = requests.put(uri, headers={"Content-Range": f"bytes */{total}"}, timeout=60)
    if r.status_code in (200, 201):
        return total, r
    rng = r.headers.get("Range")  # "bytes=0-b"
    return (int(rng.split("-")[1]) + 1 if rng else 0), r


def smoketest(refresh_token):
    cid, secret = client()
    # a. token refresh
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "grant_type": "refresh_token", "refresh_token": refresh_token,
        "client_id": cid, "client_secret": secret}, timeout=30)
    step("a token refresh", r.ok and "access_token" in r.json(), f"HTTP {r.status_code}")
    auth_h = {"Authorization": f"Bearer {r.json()['access_token']}"}

    # b. find-or-create folder (drive.file: only folders this app created are visible)
    q = f"name='{FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    r = requests.get(f"{DRIVE}/files", params={"q": q, "fields": "files(id)"}, headers=auth_h, timeout=30)
    files = r.json().get("files", []) if r.ok else []
    if files:
        folder = files[0]["id"]
    else:
        r = requests.post(f"{DRIVE}/files", headers=auth_h, timeout=30, json={
            "name": FOLDER_NAME, "mimeType": "application/vnd.google-apps.folder"})
        folder = r.json().get("id") if r.ok else None
    step("b folder", bool(folder), f"DRIVE_FOLDER_ID={folder}")

    # c. 70 MB random file + md5
    data = os.urandom(SIZE)
    md5 = hashlib.md5(data).hexdigest()
    step("c test data", len(data) == SIZE, f"md5={md5}")

    # d. resumable session exactly as §7
    r = requests.post(UPLOAD, headers={**auth_h, "X-Upload-Content-Length": str(SIZE),
                                       "X-Upload-Content-Type": "video/mp4"},
                      json={"name": "vf-smoketest.mp4", "parents": [folder]}, timeout=30)
    uri = r.headers.get("Location")
    step("d session", r.status_code == 200 and bool(uri), f"HTTP {r.status_code}")

    # e. chunks with NO Authorization header; simulated drop after chunk 1, resume via bytes */size
    r = put_chunk(uri, data[:CHUNK], 0, SIZE)
    ok = r.status_code == 308
    offset, r = query_offset(uri, SIZE)  # pretend the connection dropped here
    ok = ok and offset == CHUNK
    result = None
    while offset < SIZE:
        r = put_chunk(uri, data[offset:offset + CHUNK], offset, SIZE)
        if r.status_code == 308:
            rng = r.headers.get("Range")
            offset = int(rng.split("-")[1]) + 1 if rng else 0
        elif r.status_code in (200, 201):
            result, offset = r.json(), SIZE
        else:
            break
    step("e chunked upload + resume", ok and bool(result), f"file_id={result and result.get('id')}")
    file_id = result["id"]

    # f. verify size + md5
    r = requests.get(f"{DRIVE}/files/{file_id}", params={"fields": "size,md5Checksum,webViewLink"},
                     headers=auth_h, timeout=30)
    meta = r.json()
    step("f verify", int(meta.get("size", -1)) == SIZE and meta.get("md5Checksum") == md5,
         f"size={meta.get('size')} md5={meta.get('md5Checksum')}")

    # g. anyone-with-link reader
    r = requests.post(f"{DRIVE}/files/{file_id}/permissions", headers=auth_h,
                      json={"role": "reader", "type": "anyone"}, timeout=30)
    step("g share", r.ok, meta.get("webViewLink", ""))

    print(f"\nDRIVE_FOLDER_ID={folder}\nOpen in a private window: {meta.get('webViewLink')}")
    # h. ask before deleting
    if input("Delete the test file now? [y/N] ").strip().lower() == "y":
        r = requests.delete(f"{DRIVE}/files/{file_id}", headers=auth_h, timeout=30)
        step("h delete", r.status_code == 204)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("auth")
    s = sub.add_parser("smoketest")
    s.add_argument("--refresh-token", required=True)
    a = p.parse_args()
    auth() if a.cmd == "auth" else smoketest(a.refresh_token)
