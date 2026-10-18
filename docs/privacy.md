# Privacy Policy

[English](privacy.md) · [简体中文](privacy.zh-CN.md)

Effective October 8, 2026. This policy covers the Follow Garden extension and its static website.

## Data and purpose

The extension processes account IDs, names, handles, bios, follower/following counts, avatar URLs and relationship fields to help you manage X following. It locally stores snapshots and their completeness/time, protection notes, review selections, task and single-account block results and your language preference. It does not process direct messages, address books or payment data.

## Authentication and recipients

After you connect X and grant optional access, necessary request headers are observed only from the connected X tab. Authorization, CSRF and operation identifiers stay briefly in background memory, expire after ten minutes and are not logged, exported or persistently stored. Requests use existing X cookies without reading their values. We do not request an X password or token.

Reads and confirmed unfollow/block actions go directly to `x.com` or `api.x.com`. Avatar requests go to HTTPS `pbs.twimg.com` without a page referrer. No account records are sent to a developer server. The extension does not collect general browsing history; it observes the limited X requests needed for its purpose.

Optional TwitterAPI.io mode sends your own API key, the target username or ID and pagination parameters directly to `api.twitterapi.io` only when you request a read. It never sends X cookies or session credentials. The provider applies its own privacy and billing rules; this mode performs no third-party unfollow or block actions.

## Storage and controls

Snapshots, organization records, task history and language use local browser storage, with no Chrome sync or developer cloud backup. The current profile snapshot and account-specific organization/task records remain until replaced or cleared. The connected tab ID uses session storage.

Provider keys use extension-only session storage by default. Choosing Remember saves the key unencrypted in extension-local storage on this device. Keys are excluded from snapshots and exports. You can remove just the key or clear all data.

Settings lets you export CSV and clear local account records, task records and keys. Clearing data disconnects X and restores fictional demo data; language preference remains. It cannot remove files already exported or undo actions already completed on X. Each new unfollow task or single-account block requires explicit confirmation. Uncertain results are not automatically replayed.

## Website and other uses

We do not sell data or use it for advertising, analytics, creditworthiness or lending. The static website stores only a language preference and has no analytics or forms. GitHub Pages may process ordinary access logs under GitHub's privacy policy. Requests to X and TwitterAPI.io are subject to their respective policies.

## Contact and updates

For general support, use [GitHub Issues](https://github.com/iruochen/follow-garden/issues) without sharing credentials or private account records. Security reports should follow [SECURITY.md](../SECURITY.md). Changes to data practices will update this policy and its effective date.

Follow Garden is independent and is not affiliated with X Corp.
