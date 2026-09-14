# Verifying a Linux download

Every `.AppImage`, `.deb` and `.rpm` in a release has a detached GPG
signature beside it, named after the file with `.asc` appended.

The public key is [`loupe-release.asc`](loupe-release.asc) in this
directory, and the same key is published on the
[Loupe documentation](https://www.kryptonhq.com/loupe/#verifying-a-download).
Check the fingerprint against both before trusting it.

Fingerprint: _published with the first signed release_

```bash
gpg --import loupe-release.asc
gpg --verify Loupe_0.2.0_amd64.deb.asc Loupe_0.2.0_amd64.deb
```

Want `Good signature from "Loupe Release Signing"`, and a primary key
fingerprint matching the one above. A `WARNING: This key is not
certified with a trusted signature` line is normal — it means you have
not signed the key yourself, not that the signature is bad.

The `.sig` files in the release are something else: minisign signatures
the built-in updater checks. They are not GPG signatures and will not
verify with `gpg`.

Releases before signing was introduced have no `.asc` files.
