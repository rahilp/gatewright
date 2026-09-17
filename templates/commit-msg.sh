# gatewright:start — managed by `gw hook install`; run `gw hook uninstall` to remove
# Refuse a commit that no item on the board accounts for. `gw guard` decides;
# this only routes the message file to it. The probe matters: when gw is absent
# — or is an older CLI that has no `guard` — the hook steps aside. A missing or
# stale tool must never be what makes a repository uncommittable.
if command -v gw >/dev/null 2>&1 && gw guard --help >/dev/null 2>&1; then
  gw guard --message-file "$1" || exit 1
elif command -v npx >/dev/null 2>&1 && npx --no-install gw guard --help >/dev/null 2>&1; then
  npx --no-install gw guard --message-file "$1" || exit 1
fi
# gatewright:end
