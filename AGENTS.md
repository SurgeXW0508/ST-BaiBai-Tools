# Personal ST-BaiBai-Tools

- `main` is the unchanged `baibai-git/ST-BaiBai-Tools:main` synchronization baseline.
- `personal/stable` is the validated personal deployment branch; do not install `main` for the stable combination.
- Before changing a personal policy or updating upstream, read the canonical
  [Personal SillyTavern maintenance rules](https://github.com/SurgeXW0508/SillyTavern/blob/release/docs/personal-fork/MAINTENANCE_COMPATIBILITY.md)
  and perform Capability Ownership Review. Do not duplicate the matrix here.
- Save Generate is not assembled for any provider. Do not re-enable it automatically.
- Do not add ST compatibility hooks/adapters without that review. If upstream provides a reliable true Feature Off, prefer deleting this personal diff.
- Preserve the upstream module sources. Build `dist` from source and run the policy and affected adjacent tests before advancing `personal/stable`.
