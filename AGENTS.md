# Personal ST-BaiBai-Tools

- `main` is the unchanged `baibai-git/ST-BaiBai-Tools:main` synchronization baseline.
- `personal/stable` is the validated personal deployment branch; do not install `main` for the stable combination.
- Before changing a personal policy or updating upstream, read the canonical
  [Personal SillyTavern maintenance rules](https://github.com/SurgeXW0508/SillyTavern/blob/release/docs/personal-fork/MAINTENANCE_COMPATIBILITY.md)
  and perform Capability Ownership Review. Do not duplicate the matrix here.
- Save Generate is not assembled for any provider. Do not re-enable it automatically.
- Do not add ST compatibility hooks/adapters without that review. If upstream provides a reliable true Feature Off, prefer deleting this personal diff.
- Preserve the upstream module sources. Build `dist` from source and run the policy and affected adjacent tests before advancing `personal/stable`.

- Read [the Personal Maintenance and NAS Update runbook](docs/PERSONAL_MAINTENANCE.md) for the exact upstream-sync, build, stable-promotion, and SillyTavern Extension Manager deployment flow.
- The NAS extension must remain on `origin=SurgeXW0508/ST-BaiBai-Tools`, branch `personal/stable`, tracking `origin/personal/stable`. Never point the production extension at the author's repository or personal `main`.
- After a Runtime-affecting task is implemented, tested, and reviewed, provide a deployment handoff: state whether NAS runtime changes are needed, whether the change has reached `personal/stable`, distinguish source/`dist` changes from documentation-only commits, give the exact before/after commit, and explicitly ask whether the user wants to update NAS now.
- If the change is documentation-only or test-only, explicitly state that no NAS Runtime update is required (although the Extension Manager may still show a commit update).
- Never update NAS, publish a release, or alter the production branch without explicit user authorization. When deployment is authorized, use the SillyTavern Extension Manager and full browser refresh as documented; do not require SSH or Docker rebuild for this frontend extension.
