# Code Signing Policy

**Project:** Sanlos Music — a Windows desktop client for the [fnOS](https://www.fnos.com) music service
**Repository:** https://github.com/pure2199/sanlos-music
**License:** MIT (see [LICENSE](./LICENSE))
**Primary platform:** Windows 10 1809+ / x64
**Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org)**

> 中文版（面向维护者）：[docs/signing.md](./docs/signing.md)

> ⚠️ **Current status (2026-11-12)**: the SignPath Foundation application was **declined**
> (insufficient public visibility signals — not a judgement of software quality), so **the
> artefacts published so far are unsigned**. The "publisher identity" they would otherwise
> lack is instead covered by GitHub **artifact attestations** (SLSA build provenance, issued by
> Sigstore), which prove that the binaries were built by this repository's CI from the
> corresponding tag. See `docs/signing.md` (Chinese) and `docs/packaging.md` §7.10.
>
> This policy is kept **as is** for a future re-application — the wording of the signing
> provider line above is the one SignPath requires verbatim.

---

## 1. What is signed

Starting with the first SignPath-approved release, the following two distributable Windows
binaries are Authenticode-signed:

| Artifact | File name pattern | Notes |
|---|---|---|
| NSIS installer | `SanlosMusic-Setup-<version>.exe` | The file a user downloads and runs — this is the one Windows SmartScreen judges |
| Portable build | `SanlosMusic-Portable-<version>.exe` | The self-extracting single-file build |

> ⚠️ **T89-㉔ 起文件名与软件名一致**（`productName` = `Sanlos Music` ⇒ **去掉空格** = `SanlosMusic`）⇒
> `gh attestation verify "SanlosMusic-Setup-<version>.exe" --repo pure2199/sanlos-music`。
> ⚠️ **为什么去掉空格**（2026-11-13 实测）：GitHub 会把 Release 资产名里的**空格换成点**，
> 且**带空格的下载 URL 直接 404** ⇒ 空格名会让「自动更新清单的 url」与
> 「attestation 的 subject 名」都对不上（信任锚白做）。
> 更早的版本（v0.2.8 及以前）叫 `FN-Music-Setup-<version>.exe`。

Everything else in a release (update manifest `latest.json`, release notes) is not code and is
not signed.

**Explicitly out of scope**

- The application executable *inside* the NSIS installer. An NSIS installer is a compressed
  archive; SignPath can sign the installer itself but cannot sign files nested inside it.
  This is the normal state of affairs for every NSIS-packaged Electron application.
- Third-party binaries shipped inside the bundle (the Electron runtime). They carry their own
  upstream signatures and are never re-signed with our certificate.
- Any binary produced outside the release workflow (local builds, branch builds, pull-request
  builds). They are never signed and never published.

The exact set of signed files is declared in
[`.signpath/artifact-configurations/default.xml`](./.signpath/artifact-configurations/default.xml),
which is the artifact configuration SignPath applies to every request.

## 2. Where the artifacts are built

Every released binary is produced by the GitHub Actions workflow
[`release.yml`](./.github/workflows/release.yml), running on a GitHub-hosted runner:

1. the workflow checks out the **release tag** (`v*`) of this repository;
2. it installs dependencies with `npm ci` and runs typecheck, unit tests and the production build;
3. it runs `node scripts/pack.cjs`, which produces the installer and the portable build;
4. the unsigned artifacts are uploaded as a GitHub Actions artifact;
5. a signing request is submitted to SignPath, which fetches the artifact **by artifact id**;
6. the signed artifact is downloaded back, verified, and only then published.

Consequences that matter for the integrity of this policy:

- The CI user identity is **not trusted** to sign anything directly. It can only *submit* a
  request; the private key never leaves SignPath's HSM.
- SignPath's **GitHub trusted-build-system integration** verifies that the artifact came from a
  run of this repository's workflow. An artifact that was built anywhere else cannot be signed
  through this pipeline, because there is no artifact id for it.
- The workflow **fails** — it does not publish anything — if the signature is missing, is not in
  state `Valid`, carries no RFC 3161 timestamp, or was issued to an unexpected signer.

## 3. Team roles

This is a **single-maintainer** project. All three signing roles are held by the repository
owner, who is also the only account with push access:

| Role | Who | What they do |
|---|---|---|
| Author / Committer | `pure2199` (repository owner) | Writes and pushes code; cuts release tags |
| Reviewer | `pure2199` (repository owner) | Reviews every change before it lands |
| Approver | `pure2199` (repository owner) | Approves each individual signing request in the SignPath web interface |

Because one person holds all three roles, the separation-of-duties control is provided by the
**explicit, per-release human approval step**: no release is signed without a deliberate
approval action in SignPath, and the approval is recorded in SignPath's audit log.

**Multi-factor authentication** is a hard requirement of the SignPath Foundation programme:
every team member must enable MFA both on their SignPath account and on the source repository
host. Enabling MFA on the GitHub account of the maintainer is a **prerequisite for the first
signing request** and is being completed before that request is submitted; the SignPath account
is registered with MFA at the same time. The CI token is a separate, non-personal identity with
the `Submitter` role only; it can neither approve nor sign.

## 4. Keys, credentials and secrets

- The code-signing private key is generated and held **inside SignPath's HSM**. It is never
  exported, never copied, and never present in this repository, in a build runner, or in a
  maintainer workstation.
- The CI holds exactly **one** secret: a SignPath API token belonging to a CI user whose only
  permission is to *submit* signing requests (`Submitter`). It cannot approve requests and
  cannot sign anything by itself.
- No certificate, private key, token or passphrase is ever committed. The repository's
  `.gitignore` excludes the directories used for locally generated test certificates
  (`release/certs/`), and the release workflow reads all credentials from GitHub Actions
  secrets/variables at run time.
- Local self-signed certificates exist **only** as a developer aid for exercising the signing
  code path (`tools/fn-make-selfsigned-cert.mjs`). They are untrusted by definition, are never
  used by the release workflow, and are never published to a public release.

## 5. Manual approval per release

SignPath Foundation requires that each release be approved individually. The release workflow
submits a request and then waits (up to 90 minutes) for the approver to act in the SignPath web
interface. If the request is not approved in time, is rejected, or produces an artifact that
fails verification, **the workflow fails and nothing is published**.

## 6. Certificate expiry, revocation and compromise

- The SignPath Foundation certificate is issued and renewed by SignPath. The signature on every
  release carries an **RFC 3161 timestamp**, so an expired certificate does not invalidate
  previously published installers.
- The release workflow **refuses to publish** an artifact without a timestamp, precisely so that
  a future certificate expiry cannot invalidate the release history.
- If a signing credential or the CI token is suspected to be compromised, it is revoked in
  SignPath immediately and rotated in GitHub; the release workflow fails closed in the meantime
  (it never falls back to publishing unsigned artifacts).
- If SignPath Foundation rejects the application, or the single-maintainer arrangement is not
  accepted, the project switches to a commercially issued OV certificate (the signer name then
  becomes the organisation's legal entity name). The signing code in this repository is not
  bound to SignPath and requires only a different expected signer name.

## 7. Pre-publication verification checklist

Every release, before any asset is uploaded, must pass all of the following (the workflow
enforces them mechanically):

- [x] The build came from the release tag of this repository, in the GitHub Actions workflow.
- [x] Typecheck, unit tests and the production build all passed.
- [x] `Get-AuthenticodeSignature` reports `Status = Valid` for every published executable.
- [x] Every published executable has a non-empty `TimeStamperCertificate` (RFC 3161 timestamp).
- [x] The signer certificate's `CN` equals the expected signer name, exactly.
- [x] The update manifest `latest.json` was regenerated **after** signing, so its SHA-512
      matches the published installer byte for byte.
- [x] The published asset set contains no artifact that was computed from the *unsigned*
      binary.

## 8. Privacy

This project does not transfer any information to other networked systems other than as
required and expected by the people who install or operate it:

- the application talks only to the user's own fnOS music server (or the user's own copy of the
  project's mock server, for development);
- if the user enables update checking, the application contacts the update server address that
  the user configured themselves;
- the release pipeline contacts GitHub (source, artifacts) and SignPath (signing service).

## 9. Contact

For questions about this policy: open an issue in this repository, or contact the maintainer
through the repository's issue tracker.
