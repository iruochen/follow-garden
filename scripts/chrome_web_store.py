"""Check the Follow Garden store listing or submit a verified Release ZIP."""

import argparse
import http.client
import json
import os
from pathlib import Path
import re
import sys
import time
from zipfile import BadZipFile, ZipFile


ITEM_ID = "njapleffcdeikalapdhkgkpbbhdnlmcg"
ACTIVE_SUBMISSIONS = {"PENDING_REVIEW", "STAGED"}
UPLOAD_IN_PROGRESS = {"IN_PROGRESS", "UPLOAD_IN_PROGRESS"}


def version_key(version):
    if not re.fullmatch(r"[0-9]{1,5}(\.[0-9]{1,5}){0,3}", version):
        raise ValueError("Invalid Chrome extension version.")
    return tuple(map(int, (version + ".0.0.0").split(".")[:4]))


def versions(revision):
    return {channel["crxVersion"] for channel in revision.get("distributionChannels", [])}


def check_package(tag, package):
    if not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
        raise ValueError("Expected a Release tag such as v0.1.4.")
    version = tag[1:]
    if any(part > 65535 for part in version_key(version)):
        raise ValueError("Chrome extension version components must be at most 65535.")
    if package.name != f"follow-garden-{version}.zip":
        raise ValueError("ZIP filename does not match the Release tag.")
    with ZipFile(package) as archive:
        if json.loads(archive.read("manifest.json"))["version"] != version:
            raise ValueError("ZIP manifest version does not match the Release tag.")
    return version


class ChromeWebStore:
    def __init__(self, publisher, token):
        if not re.fullmatch(r"[A-Za-z0-9-]+", publisher) or not token:
            raise ValueError("A publisher ID and OAuth access token are required.")
        self.name = f"publishers/{publisher}/items/{ITEM_ID}"
        self.token = token

    def request(self, method, route, operation, body=None, headers=None):
        connection = http.client.HTTPSConnection("chromewebstore.googleapis.com", timeout=45)
        try:
            connection.request(method, f"{route}/{self.name}:{operation}", body, {
                "Authorization": f"Bearer {self.token}",
                **(headers or {}),
            })
            response = connection.getresponse()
            if not 200 <= response.status < 300:
                raise ValueError(f"{operation} returned HTTP {response.status}. Check the Developer Dashboard before retrying.")
            result = json.load(response)
        finally:
            connection.close()
        if not isinstance(result, dict) or result.get("name") != self.name or result.get("itemId") != ITEM_ID:
            raise ValueError(f"{operation} did not confirm the expected store item.")
        return result

    def status(self):
        return self.request("GET", "/v2", "fetchStatus")

    def upload(self, package, version):
        result = self.request("POST", "/upload/v2", "upload", package.read_bytes(), {
            "Content-Type": "application/zip",
            "X-Goog-Upload-Protocol": "raw",
            "X-Goog-Upload-File-Name": package.name,
        })
        if result.get("uploadState") == "SUCCEEDED" and result.get("crxVersion") == version:
            return
        if result.get("uploadState") in UPLOAD_IN_PROGRESS:
            # fetchStatus gives no draft version. Observe this upload's transition
            # before relying on a success state that could belong to an earlier run.
            processing = False
            for _ in range(12):
                state = self.status().get("lastAsyncUploadState")
                if state in UPLOAD_IN_PROGRESS:
                    processing = True
                elif state == "SUCCEEDED" and processing:
                    return
                if state == "FAILED":
                    break
                time.sleep(5)
        raise ValueError("The store did not confirm the upload. Check the Developer Dashboard before retrying.")

    def publish(self):
        self.request("POST", "/v2", "publish",
                     json.dumps({"publishType": "DEFAULT_PUBLISH", "blockOnWarnings": True}),
                     {"Content-Type": "application/json"})


def report(status):
    for label in ("published", "submitted"):
        revision = status.get(f"{label}ItemRevisionStatus") or {}
        print(f"{label}: {revision.get('state', 'none')} ({', '.join(sorted(versions(revision))) or 'no version'})")


def submit(store, package, version, status):
    published = status.get("publishedItemRevisionStatus") or {}
    submitted = status.get("submittedItemRevisionStatus") or {}
    if status.get("takenDown") or status.get("warned"):
        raise ValueError("The item requires attention in the Developer Dashboard.")
    if version in versions(published):
        print(f"{version} is already published.")
        return
    if submitted.get("state") in ACTIVE_SUBMISSIONS:
        if version in versions(submitted):
            print(f"{version} already has an active submission.")
            return
        raise ValueError("Another version is already in review or staged.")
    if status.get("lastAsyncUploadState") in UPLOAD_IN_PROGRESS:
        raise ValueError("The store is already processing an upload.")
    if any(version_key(version) <= version_key(previous) for previous in versions(published)):
        raise ValueError("Release version must be newer than the published version.")

    store.upload(package, version)
    store.publish()
    for _ in range(6):
        status = store.status()
        published = status.get("publishedItemRevisionStatus") or {}
        submitted = status.get("submittedItemRevisionStatus") or {}
        if version in versions(published) or (
            submitted.get("state") in ACTIVE_SUBMISSIONS and version in versions(submitted)
        ):
            report(status)
            return
        time.sleep(3)
    raise ValueError("The store did not confirm the submitted version. Check status before retrying.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", nargs="?")
    parser.add_argument("package", nargs="?", type=Path)
    args = parser.parse_args()
    if args.tag and args.package is None:
        parser.error("A Release tag and its verified ZIP are required together.")
    try:
        version = check_package(args.tag, args.package) if args.tag else None
        store = ChromeWebStore(os.environ.get("CWS_PUBLISHER_ID", ""), os.environ.get("CWS_ACCESS_TOKEN", ""))
        status = store.status()
        if version:
            submit(store, args.package, version, status)
        else:
            report(status)
    except (ValueError, OSError, BadZipFile, http.client.HTTPException, KeyError) as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
